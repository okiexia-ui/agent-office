# 部署与维护

## 当前架构

```text
浏览器 ── Sites 私有站点登录 ──┐
                              ├── Worker ── R2 BUCKET
Hermes ── 私有服务访问请求头 ──┘
```

当前站点：<https://agent-office-studio-nov11.okiexia.chatgpt.site>。

`office.tommyxia.org` 已申请绑定，但截至本次源码归档，DNS 验证尚未完成。Hermes 配置继续使用上面的有效托管地址。

## 构建与发布

```bash
npm install          # 本机预览、构建与测试依赖
npm run check        # 语法与格式
npm test             # 服务端、存储和正式构建测试
npm run package      # 构建并生成 release/agent-office-<版本>-sites.tar.gz 与 SHA256SUMS.txt
```

`npm run build` 做这些事：

- 用 esbuild 打包三个页面的脚本：工作台 `index.html`、嵌入场景 `embed.html`、完整办公室 `office.html`。公共代码拆成共享块，3D 场景（含按需裁剪的 Three.js）是按需加载的独立块；全部压缩。
- 脚本与样式输出到 `/assets/`，文件名带内容指纹，由 Worker 以 `Cache-Control: public, max-age=31536000, immutable` 返回。页面、图标、清单等其他文件以 `no-cache` 加 ETag 返回，未变化时为 304。
- 改写页面引用、去掉开发用的 importmap、为首屏依赖加 `modulepreload`，并在应用页面中注册 Service Worker。
- 由 `scripts/service-worker.js` 生成 `/sw.js`，写入构建版本和预缓存列表。
- 把 `worker/` 打包进 `dist/server/index.js`，并嵌入全部静态文件；PNG 图标以 base64 嵌入，首次请求时解码。复制 `.openai/hosting.json` 到 `dist/.openai/hosting.json`。

`npm run preview` 在 <http://127.0.0.1:3090/> 运行这个构建产物，行为与线上一致（除站点登录外）。`npm run dev` 则直接提供未打包的源文件，不注册 Service Worker，便于调试。

发布：在 Codex 中通过 Sites 发布到 `.openai/hosting.json` 中的项目，源码使用本仓库 `main`，或直接使用 `npm run package` 生成的部署包（包含 `dist/.openai/hosting.json` 与 `dist/server/index.js`）。发布不需要修改 R2 绑定或密钥。

## Sites 所需配置

| 配置 | 用途 |
| --- | --- |
| 私有站点访问策略 | 仅允许站点所有者与获授权服务访问 |
| `capabilities: ["mcp"]` | 启用原生 MCP 接入 |
| `r2: "BUCKET"` | 为 Worker 绑定持久化对象存储 |
| `HERMES_SITE_ACCESS_TOKEN` 运行时密钥 | 向已登录所有者提供 Hermes 服务访问凭证下载 |

`HERMES_SITE_ACCESS_TOKEN` 必须是该站点有效的服务访问凭证，在部署平台密钥设置中配置。任意自创字符串不会让 Sites 网关接受请求。仓库不包含此值。

本仓库保留现有站点的 `project_id`。如果部署为另一个 Sites 项目，应使用新项目 ID 和该项目的绑定、访问策略与密钥；同时更新 `public/app.js` 中的 `MCP_URL`、配置模板和说明文档里的站点地址。

GitHub 仓库用于源码存档与维护；当前没有 GitHub 自动部署工作流。修改源代码后需要重新构建，并通过 Sites 的部署流程发布到对应项目。

## 认证边界

Worker 信任 Sites 网关完成访问认证，`/api/hermes/credentials` 还依赖网关注入的 `oai-authenticated-user-id`。如果离开 Sites 部署，不能直接将 Worker 裸露为公开服务。应先实现等效的身份验证、授权，并确保来自客户端的身份请求头不能伪造。

| 路由 | 功能 |
| --- | --- |
| `GET /api/health` | 服务与存储配置状态 |
| `GET /api/sync?scope=group\|<agentId>` | 工作台的唯一轮询：办公室状态、成果目录、执行记录与当前会话；带 `If-None-Match` 且无变化时返回 304，只读对象元信息 |
| `GET /api/state` | 读取共享办公室状态（完整办公室使用，同样支持 304） |
| `PUT /api/state` | 按 revision 更新状态，保留服务器中的聊天记录 |
| `GET /api/chat?agentId=...` | 读取该成员的最近聊天记录 |
| `POST /api/chat` | 保存用户留言；携带 `agentId`、`content`、`requestId` |
| `GET /api/channel` | 读取最近 200 条公共讨论及最新序号 |
| `POST /api/channel` | 保存人的公共发言；支持 `mentions`、`replyTo`、`taskId`，不能指定 Agent 身份 |
| `GET /api/visuals` | 读取成果元信息，可按伙伴、任务或消息筛选 |
| `GET /api/visuals/:id` | 读取一份成果的完整内容 |
| `GET /api/steps` | 读取执行记录，支持增量序号及筛选 |
| `POST /mcp` | Sites 原生 OAuth MCP |
| `POST /api/hermes/mcp` | Hermes 服务访问 MCP |
| `GET /api/hermes/credentials` | 所有者登录后下载私有凭证 |

## 数据与容量

- R2 对象：`office/state-v2.json`，包含成员（含 `seatId`）、任务、动态、聊天记录、成果目录、执行记录和版本信息。旧数据首次读取时自动分配工位，保留原有成员和任务。
- 成果正文：每份一个对象 `office/visuals/<visual_id>.json`。先写正文、再条件提交目录；重复请求或被保留策略移出的成果会删除对应正文。2.4 之前内联保存在主对象中的成果，会在下次有 Agent 发布成果时自动迁出。
- 上限：16 位成员及对应工位、200 个任务、40 条最近动态。每位成员保留最近最多 100 条聊天消息（约 50 轮）；清理时成对移除已回复消息，保留未回复留言。每位成员最多 10 条待回复留言。
- 聊天记录仍使用同一个 R2 对象的 ETag 条件更新。`/api/state` 不返回聊天正文，普通状态 PUT 不可伪造聊天回复。
- 公共频道增加 `channelMessages`、`channelSequence`、`channelReads`，旧状态自动补充为空。保留最新 200 条消息，序号持续递增；读取响应提示历史是否被裁剪。普通状态 PUT 保留频道记录和已读位置。
- Visual 保留最新 40 份成果，单份正文最多 32,000 字符；执行记录保留最新 200 条，使用单调递增序号。写入通过 MCP，浏览器状态保存不会覆盖这些记录。
- 工作台每 4 秒一个 `/api/sync` 请求，嵌入的办公室不单独请求；5 分钟无心跳则显示离线。
- 浏览器写入检查 revision；服务写入使用 R2 ETag 条件更新，避免覆盖并发变化。
- `?demo=1` 使用浏览器本地数据，不写入 R2。

GitHub 中的代码备份不包括 R2 中的运行数据。迁移或备份办公室状态时应另行导出存储对象，并保持私有访问。

## 已有检查

`npm test` 覆盖 MCP、成员与任务、聊天、成果保留与迁移、同步、场景布局和正式构建。存储测试使用临时目录验证两个进程的条件写入，使用内存存储模拟提交后回执丢失。`npm run test:browser` 从正式构建验证重连、保存回滚、历史成果链接和首次离线打开。浏览器安装步骤见 [README](../README.md#本地预览与检查)。

## 发布 2.4.0 后

- MCP 工具仍是 17 个，参数与返回值不变；已连接的 Agent 不需要重新配置。
- 第一次打开新版本时，浏览器会注册 Service Worker；之后发布的版本会在下次打开时自动生效。
- 已有成果会在下一次 Agent 发布成果时自动迁出到独立对象，期间读取不受影响。
- 安装成应用的方法见 [APP.md](APP.md)。

## 发布 2.3.1 后

重新加载 Agent 的 MCP 连接，使其看到全部 17 个工具，包括私聊、公共频道、Visual 交付与执行记录。现有 Token 和站点访问策略保持原样。Agent 必须主动轮询收件箱；部署网站不会替你启动或配置持续运行的 Agent 进程。共同讨论的具体接入顺序见 [CHAT.md](CHAT.md)，新增成果与执行记录接口见 [WORKSPACE.md](WORKSPACE.md)。

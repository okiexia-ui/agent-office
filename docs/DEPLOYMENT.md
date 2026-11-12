# 部署与维护

## 当前架构

```text
浏览器 ── Sites 私有站点登录 ──┐
                              ├── Worker ── R2 BUCKET
Hermes ── 私有服务访问请求头 ──┘
```

当前站点：<https://agent-office-studio-nov11.okiexia.chatgpt.site>。

`office.tommyxia.org` 已申请绑定，但截至本次源码归档，DNS 验证尚未完成。Hermes 配置继续使用上面的有效托管地址。

## 构建

```bash
npm run check
npm test
npm run build
```

构建脚本把 `public/` 中的文本资源嵌入 `dist/server/index.js`，同时复制 `.openai/hosting.json` 到 `dist/.openai/hosting.json`。当前构建不支持直接嵌入二进制资源。

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
| `GET /api/state` | 读取共享办公室状态 |
| `PUT /api/state` | 按 revision 更新状态 |
| `POST /mcp` | Sites 原生 OAuth MCP |
| `POST /api/hermes/mcp` | Hermes 服务访问 MCP |
| `GET /api/hermes/credentials` | 所有者登录后下载私有凭证 |

## 数据与容量

- R2 对象：`office/state-v2.json`，包含成员、任务、动态和版本信息。
- 上限：16 位成员、200 个任务、40 条最近动态。
- 浏览器每 4 秒同步；5 分钟无心跳则显示离线。
- 浏览器写入检查 revision；服务写入使用 R2 ETag 条件更新，避免覆盖并发变化。
- `?demo=1` 使用浏览器本地数据，不写入 R2。

GitHub 中的代码备份不包括 R2 中的运行数据。迁移或备份办公室状态时应另行导出存储对象，并保持私有访问。

## 已有检查

`npm test` 包含 10 组后端测试，覆盖 MCP 握手、工具发现、成员登记、实际在线状态、任务创建与去重、优先级、任务归属、完成计数、并发更新、输入验证及凭证下载边界。测试使用内存存储替身，不替代部署后的身份认证与实际 R2 验证。

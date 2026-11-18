# Agent Office · 对话与 Visual 工作台

一个可以让 Hermes Agent 入驻的 3D 可视化办公室。网页展示成员状态、任务进度和最近动态；Hermes 通过 MCP 领取任务、发送心跳并汇报执行结果。

- 在线办公室：<https://agent-office-studio-nov11.okiexia.chatgpt.site>（需站点所有者登录）
- 演示模式：<https://agent-office-studio-nov11.okiexia.chatgpt.site/?demo=1>
- [安装成应用](docs/APP.md) · [Hermes 接入步骤](docs/HERMES.md) · [部署说明](docs/DEPLOYMENT.md) · [配置模板](public/hermes-config.yaml) · [更新记录](CHANGELOG.md)

## 2.4.0 更快、更省、可以装成应用

工作台和完整办公室都可以安装到手机主屏幕、Mac 程序坞或 Windows 开始菜单，在独立窗口中打开（PWA），断网时显示离线提示。工作台每 4 秒只发一个同步请求，办公室没有变化时服务器直接返回 304；成果正文独立存储，主数据保持小巧。前端经过打包、裁剪和压缩，首屏下载量明显降低；手机上能看到全部伙伴的位置。MCP 工具和数据格式保持兼容。详见 [更新记录](CHANGELOG.md) 与 [安装成应用](docs/APP.md)。

## 2.3.1 左右协作工作台

首页采用左右协作布局：左侧常驻 3D 办公室与成果，右侧默认打开群聊。伙伴、工作状态、@ 点名、引用回复和成果卡片都直接可见，点击场景人物或发言头像即可切到私聊。成果区支持展开和恢复分屏，可查看图表、表格、文档、隔离的交互 HTML 与执行记录。手机上方保留办公室，下方群聊，成果按需展开。原有完整办公室仍在 `/office.html`。

新增 5 个 MCP 工具，总数 17；旧消息与任务协议保持兼容。网页仍需要运行中的外部 Agent 来生成真实回答。详见 [工作台与 MCP 接入](docs/WORKSPACE.md)。

![左右协作工作台：左侧办公室与成果，右侧伙伴群聊](docs/images/workspace-v2.3.1.jpg)

截图使用本地演示数据。GitHub 源码与在线办公室的访问权限分别管理；托管办公室仍需所有者登录。下载源码后可以运行本地演示。

## 功能

- Three.js 3D 办公室与群聊同时可见：旋转、缩放、预设视角、日夜主题和手机布局；当前任务显示在场景下方，成果交付显示在群聊与左侧成果区。
- 常驻视角控制：左右旋转、俯仰、平移、50%–320% 缩放、名称开关和复位；窄屏保留全部控件，展开后铺满屏幕。画布聚焦时支持方向键、+/− 和 0 复位。
- 16 个独立工位：自动分配、空位招募、换座和交换工位，休息时保留自己的位置。
- 成员管理、任务分配、暂停、继续、完成以及活动记录；任务页按「派发 → 领取 → 执行 → 完成」展示每个任务走到哪一步，并显示 Agent 提交的结果。
- 点击成员开始 Agent Chat：独立会话、草稿切换、历史记录、等待回复与失败重试。
- 办公室公共频道：你和 Agent 一起讨论工作，支持 @ 同事、引用回复、关联任务及按任务筛选；Agent 可通过 MCP 互相发言。
- 可点击咖啡机、办公室小猫、庆祝彩纸，以及独立的 25 分钟专注计时；趣味互动不修改实际任务状态。
- 实时模式使用云端 R2 存储，每 4 秒一个同步请求，无变化时返回 304；并发修改使用版本号和 ETag 检查。
- 可安装为应用（PWA）：主屏幕 / 程序坞图标、独立窗口、快捷入口和离线提示。
- 17 个 MCP 工具供 Agent 登记、发送心跳、查询和更新任务、收发私聊及公共讨论。
- `?demo=1` 使用独立的浏览器本地演示数据，可体验模拟工作状态。

实时模式初始只有一个等待连接的 Hermes 成员。只有 Agent 实际上报才显示在线；超过 5 分钟未上报显示离线。网页负责展示与派发任务，执行工作需要你自己的 Hermes 进程。

## 本地预览与检查

需要 Node.js 20.11 或更新版本。Three.js 已随项目提供；`npm install` 只安装构建与格式化工具（esbuild、Prettier）。

```bash
git clone https://github.com/okiexia-ui/agent-office.git
cd agent-office
npm install
npm run check      # 语法与格式
npm test           # 61 项自动测试
npm run dev        # 开发预览：未打包的源文件，修改后刷新即可
```

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 生成正式构建 `dist/server/index.js`，并列出各页面的下载量 |
| `npm run preview` | 在 <http://127.0.0.1:3090/> 运行正式构建（打包文件、缓存头、Service Worker） |
| `npm run package` | 重新构建并生成 Sites 部署包 `release/agent-office-<版本>-sites.tar.gz` 和校验值 |
| `npm run format` | 按 Prettier 规则格式化代码 |
| `npm run icons` | 在 macOS 上由 `public/icons/*.svg` 重新生成应用图标 PNG |

打开 <http://127.0.0.1:3080/?demo=1> 体验本地演示。打开 <http://127.0.0.1:3080/> 测试同一套 Worker API 和真实 Agent 消息协议；本机数据写入已忽略的 `.office-local/`（办公室状态在 `state.json`，成果正文在 `objects/`），不会访问线上数据库。使用 `OFFICE_PORT` 可更改端口。

本机 MCP 地址为 `http://127.0.0.1:3080/mcp`，仅供同一电脑上的 Agent 连接。云端运行仍需原有 Sites 认证和 R2 绑定。

聊天采用异步收件箱：私聊使用 `office_get_messages` / `office_reply_message`；公共频道使用 `office_get_channel_messages` / `office_post_channel_message`，处理后用 `office_ack_channel` 确认已读。仅把成员加入办公室不会启动模型进程。演示模式的回复始终标记为演示示例，详见 [Agent Chat 接入](docs/CHAT.md)。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| `public/index.html` / `public/workspace.js` | 左右协作工作台：群聊、私聊、成果、执行记录、安装应用 |
| `public/embed.html` / `public/embed.js` | 工作台中只含 3D 场景的办公室，数据由工作台转交 |
| `public/office.html` / `public/app.js` | 完整办公室：任务、成员、工位、连接设置 |
| `public/scene.js` / `public/camera.js` / `public/labels.js` | 3D 场景、取景与视角、名称标签排布 |
| `public/layout.js` | 浏览器与 Worker 共用的 16 工位定义及旧数据迁移 |
| `public/chat.js` / `public/channel.js` / `public/office-life.js` | 私聊、公共频道、工位管理与趣味互动 |
| `public/manifest.webmanifest` / `public/icons/` / `public/offline.html` | 应用清单、图标与离线页 |
| `public/vendor/` | Three.js 0.169.0 与 OrbitControls |
| `worker/index.js` / `worker/workspace.js` | HTTP API、同步、R2 持久化、MCP 工具、成果与执行记录 |
| `scripts/build-lib.mjs` | 正式构建：打包压缩、内容指纹、页面改写、Service Worker、Worker 打包 |
| `scripts/service-worker.js` | Service Worker 模板 |
| `scripts/dev.mjs` / `scripts/preview.mjs` / `scripts/local-bucket.mjs` | 本机开发预览、正式构建预览与本机存储 |
| `scripts/package.mjs` | 生成 Sites 部署包 |
| `tests/` | 服务端、同步、存储、布局、取景、标签与正式构建测试 |
| `.openai/hosting.json` | 当前 Sites 项目的部署配置 |
| `dist/server/index.js` | 已构建的 Worker，由 `npm run build` 重新生成 |
| `docs/` | 应用安装、Hermes 接入、工作台与部署说明 |
| `licenses/` | 第三方许可 |

## 部署与访问

当前版本运行于 ChatGPT Sites，使用私有站点访问控制、`BUCKET` R2 绑定，以及运行时密钥 `HERMES_SITE_ACCESS_TOKEN`。访问认证由 Sites 网关执行；Worker 本身没有独立登录系统。迁移到其他平台时必须配置等效认证，并处理受信任的身份请求头后再上线，详见 [部署说明](docs/DEPLOYMENT.md)。

仓库保存源代码和构建产物，不保存云端成员/任务数据库或访问密钥。向 GitHub 推送代码不会自动更新在线站点。

## 版本与第三方代码

当前源码为 Agent Office 2.4.0，包含工位扩容、办公室互动、私聊、Agent 共同讨论频道、左右协作工作台、Visual 交付与可安装应用；本地修改需要单独部署才会更新线上。基础版本为 2.0.0 源码快照，对应 Sites 源提交 `95d30ccad866f5ef65b4bde62889f204a9c8ed28`。本次更新：2026-11-18。

Three.js 与 OrbitControls 使用 MIT 许可，见 [licenses/three-LICENSE.txt](licenses/three-LICENSE.txt)。本仓库未对其余项目代码另行授予开源许可。

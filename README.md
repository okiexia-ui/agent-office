# Agent Office · AI 办公室

一个可以让 Hermes Agent 入驻的 3D 可视化办公室。网页展示成员状态、任务进度和最近动态；Hermes 通过 MCP 领取任务、发送心跳并汇报执行结果。

- 在线办公室：<https://your-office.example>（需站点所有者登录）
- 演示模式：<https://your-office.example/?demo=1>
- [Hermes 接入步骤](docs/HERMES.md) · [部署说明](docs/DEPLOYMENT.md) · [配置模板](public/hermes-config.yaml)

## 功能

- Three.js 3D 办公室铺满主舞台：旋转、缩放、预设视角、日夜主题和手机布局；右侧一栏是成员名单与对话，私聊和公共频道停靠在这里，不遮挡场景。
- 16 个独立工位：自动分配、空位招募、换座和交换工位，休息时保留自己的位置。
- 成员管理、任务分配、暂停、继续、完成以及活动记录；任务页按「派发 → 领取 → 执行 → 完成」展示每个任务走到哪一步，并显示 Agent 提交的结果。
- 点击成员开始 Agent Chat：独立会话、草稿切换、历史记录、等待回复与失败重试。
- 办公室公共频道：你和 Agent 一起讨论工作，支持 @ 同事、引用回复、关联任务及按任务筛选；Agent 可通过 MCP 互相发言。
- 可点击咖啡机、办公室小猫、庆祝彩纸，以及独立的 25 分钟专注计时；趣味互动不修改实际任务状态。
- 实时模式使用云端 R2 存储，每 4 秒同步一次；并发修改使用版本号和 ETag 检查。
- 12 个 MCP 工具供 Agent 登记、发送心跳、查询和更新任务、收发私聊及公共讨论。
- `?demo=1` 使用独立的浏览器本地演示数据，可体验模拟工作状态。

实时模式初始只有一个等待连接的 Hermes 成员。只有 Agent 实际上报才显示在线；超过 5 分钟未上报显示离线。网页负责展示与派发任务，执行工作需要你自己的 Hermes 进程。

## 本地预览与检查

需要 Node.js 22 或更新版本。项目已包含 Three.js 文件，没有需要安装的 npm 依赖。

```bash
git clone https://github.com/okiexia-ui/agent-office.git
cd agent-office
npm run check
npm test
npm run build
npm run dev
```

打开 <http://127.0.0.1:3080/?demo=1> 体验本地演示。打开 <http://127.0.0.1:3080/> 测试同一套 Worker API 和真实 Agent 消息协议；本机数据写入已忽略的 `.office-local/state.json`，不会访问线上数据库。使用 `OFFICE_PORT` 可更改端口。

本机 MCP 地址为 `http://127.0.0.1:3080/mcp`，仅供同一电脑上的 Agent 连接。云端运行仍需原有 Sites 认证和 R2 绑定。

聊天采用异步收件箱：私聊使用 `office_get_messages` / `office_reply_message`；公共频道使用 `office_get_channel_messages` / `office_post_channel_message`，处理后用 `office_ack_channel` 确认已读。仅把成员加入办公室不会启动模型进程。演示模式的回复始终标记为演示示例，详见 [Agent Chat 接入](docs/CHAT.md)。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| `public/` | 页面、样式、交互、3D 场景和 Hermes 配置模板 |
| `public/vendor/` | Three.js 0.169.0 与 OrbitControls |
| `public/layout.js` | 浏览器与 Worker 共用的 16 工位定义及旧数据迁移 |
| `public/chat.js` / `public/channel.js` / `public/office-life.js` | 私聊、公共频道、工位管理与趣味互动 |
| `scripts/dev.mjs` | 仅监听本机的 Worker 预览和本机数据保存 |
| `worker/index.js` | HTTP API、R2 持久化和 MCP 工具实现 |
| `scripts/build.mjs` | 将静态文件打包到 Worker 的构建脚本 |
| `tests/server.test.mjs` | MCP、任务流程、并发写入和输入验证测试 |
| `.openai/hosting.json` | 当前 Sites 项目的部署配置 |
| `dist/server/index.js` | 已构建的 Worker，可通过构建命令重新生成 |
| `docs/` | Hermes 接入与部署说明 |
| `licenses/` | 第三方许可 |

## 部署与访问

当前版本运行于 ChatGPT Sites，使用私有站点访问控制、`BUCKET` R2 绑定，以及运行时密钥 `HERMES_SITE_ACCESS_TOKEN`。访问认证由 Sites 网关执行；Worker 本身没有独立登录系统。迁移到其他平台时必须配置等效认证，并处理受信任的身份请求头后再上线，详见 [部署说明](docs/DEPLOYMENT.md)。

仓库保存源代码和构建产物，不保存云端成员/任务数据库或访问密钥。向 GitHub 推送代码不会自动更新在线站点。

## 版本与第三方代码

当前源码为 Agent Office 2.2.0，新增工位扩容、办公室互动、私聊与 Agent 共同讨论频道；本地修改需要单独部署才会更新线上。基础版本为 2.0.0 源码快照，对应 Sites 源提交 `95d30ccad866f5ef65b4bde62889f204a9c8ed28`。归档日期：2026-11-12。

Three.js 与 OrbitControls 使用 MIT 许可，见 [licenses/three-LICENSE.txt](licenses/three-LICENSE.txt)。本仓库未对其余项目代码另行授予开源许可。

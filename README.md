# Agent Office

在自己的电脑上组建 AI 工作小组。为撰稿、审校、研究等岗位保存各自的职责、工作指令和模型，在同一个 3D 办公室里群聊、派任务，并取回可以下载的成果。

**Agent Office 以本地版为主**：Agent 在你的电脑上运行，办公室数据保存在本机。另有托管的远程办公室（网站版），用来接入已经在别处运行的 Agent，例如 Hermes。

## 快速开始（本地版）

1. 安装 [Node.js](https://nodejs.org) 22.19 或更新版本（长期支持版即可，也可以用 `brew install node`）。
2. **Mac**：双击项目里的「启动 Agent Office.command」。第一次会自动安装依赖，之后浏览器会打开工作台；关闭这个终端窗口即可停止。再次双击时，如果已经在运行，会直接打开工作台。
   **其他系统或命令行**：在项目目录运行 `npm ci`，然后运行 `npm start`。
3. 在工作台选一个起点：产品编辑、审校、资料研究，或者从空白开始。添加模型连接（本机 Pi，或 DeepSeek、OpenAI 等兼容接口），点「创建并开始对话」。

从网页下载压缩包解压时，macOS 可能提示无法验证开发者：右键点启动文件，选「打开」即可。用 `git clone` 获取的项目不会出现这个提示。

工作室里还可以：

- 在「模型连接」点「获取可用模型」，或直接填写模型 ID。可单独测试生成、清除已存密钥，或移除没有档案使用的连接。
- 在「Agent 设置」选择已有成员即可停用或重新启用。停用会暂停执行中的任务，保留成员、对话和成果。重启办公室会沿用停用状态。
- 在输入框选择共享文档、表格、图表或交互 HTML，群聊中再点名负责人。交付后可在成果区查看、下载，并在「执行记录」核对发布结果。来自私聊的共享交付同样对整个办公室可见。

办公室数据和模型密钥保存在本机 `.office-local/`，密钥文件只有当前用户可读。处理消息和任务时，相应内容只会发给你为该成员选择的模型服务。

## 两种使用方式

| | 本地版（推荐） | 远程办公室（网站版） |
| --- | --- | --- |
| 谁来运行 Agent | 这台电脑：本机 Pi，或你配置的模型 API | 在别处运行的 Agent，通过 MCP 接入，例如 Hermes |
| 怎么打开 | 双击启动器，或 `npm start`；默认 <http://127.0.0.1:3080/> | <https://your-office.example>（需站点所有者登录）· [演示](https://your-office.example/?demo=1) |
| 数据保存在 | 本机 `.office-local/` | 托管站点的 R2 存储 |
| 适合 | 自己组建团队，处理本机材料 | 已有远程 Agent，或要在多台设备上访问 |

默认情况下两边的成员、对话和成果分别保存，互不同步。要让本机 Pi 到远程办公室接单，见 [共享模式](docs/LOCAL-PI.md)。两种方式都可以 [装成应用](docs/APP.md)；本地版的应用窗口需要启动器在运行。

[产品综述（Word）](<docs/Agent Office 产品综述.docx>) · [本机配置与使用](docs/LOCAL-PI.md) · [安装成应用](docs/APP.md) · [Hermes 接入](docs/HERMES.md) · [部署说明](docs/DEPLOYMENT.md) · [更新记录](CHANGELOG.md)

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

远程办公室初始有一个等待连接的 Hermes 成员，超过 5 分钟未上报会显示离线。执行工作需要运行中的 Agent。本地启动器可以运行 Pi 和创建的 API 成员，远程 Hermes 由原部署运行。

## 本地预览与检查

需要 Node.js 22.19 或更新版本（与本地版相同，见 `.nvmrc`）。Three.js 已随项目提供。`npm install` 会安装本机预览、构建和测试所用的开发依赖。

```bash
git clone https://github.com/okiexia-ui/agent-office.git
cd agent-office
npm install
npm run check      # 语法与格式
npm test           # 服务端、存储和构建回归测试
npm start          # 本地版：启动并打开工作台（等同双击启动器）
npm run dev        # 开发预览：未打包的源文件，修改后刷新即可
```

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 生成正式构建 `dist/server/index.js`，并列出各页面的下载量 |
| `npm run preview` | 在 <http://127.0.0.1:3090/> 运行正式构建（打包文件、缓存头、Service Worker） |
| `npm run test:browser` | 使用 Chromium 验证重连、保存回滚、成果链接和首次离线打开 |
| `npm run package` | 重新构建并生成 Sites 部署包 `release/agent-office-<版本>-sites.tar.gz` 和校验值 |
| `npm run format` | 按 Prettier 规则格式化代码 |
| `npm run icons` | 在 macOS 上由 `public/icons/*.svg` 重新生成应用图标 PNG |

打开 <http://127.0.0.1:3080/?demo=1> 体验本地演示。打开 <http://127.0.0.1:3080/> 测试 Worker API 和真实 Agent 消息协议。开发服务和正式预览共用 `.office-local/`。办公室状态在 `state.json`，成果正文在 `objects/`。两个进程通过文件锁协调写入。使用 `OFFICE_PORT` 可更改端口。

首次运行浏览器回归测试前，执行 `npx playwright-core install --only-shell chromium`，或将 `CHROMIUM_EXECUTABLE_PATH` 指向已有的 Chromium 可执行文件。测试会为每个场景创建独立的办公室数据和浏览器上下文。

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

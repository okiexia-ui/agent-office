# Agent Office

打开 Agent Office 就能看到团队的 3D 办公室。点工位上的成员，右侧就能聊天、改设置或看文件。要一起改代码，在成员对话里选择项目文件夹，发送任务。办公室会显示谁在处理哪个项目，交付的文档、表格、图表和网页集中在场景下方。

办公室数据保存在本机。本机 Pi、配置模型 API 的成员和通过 MCP 登记的外部成员可以在同一个办公室协作。项目采用 [MIT 许可](LICENSE)。

![成员在 3D 办公室中执行项目任务，场景下方展示交付成果](docs/images/unified-office-2.8.jpg)

<sub>截图来自用于本地验证的独立示例办公室。</sub>

## 快速开始

1. 安装 [Node.js](https://nodejs.org) 22.19 或更新版本（长期支持版即可，Mac 上也可以用 `brew install node`）。
2. 获取代码：`git clone https://github.com/okiexia-ui/agent-office.git`，或在 GitHub 页面下载压缩包后解压。
3. 启动：
   - **Mac**：双击项目里的「启动 Agent Office.command」。第一次会自动安装依赖，之后浏览器会打开工作台。关闭这个终端窗口即可停止；再次双击时，如果已经在运行，会直接打开工作台。
   - **命令行**：在项目目录运行 `npm ci`，再运行 `npm start`。
4. 首页默认打开群聊。选中一位成员，点「对话 → 项目任务」，选择已有目录并输入要求。空办公室可以先用「创建 Agent」添加成员。Mac 独立窗口版的构建和使用方法见 [应用说明](docs/APP.md)。

用压缩包时，macOS 可能提示无法验证开发者：右键点启动文件，选「打开」即可。工作台默认地址是 <http://127.0.0.1:3080/>；想先看看效果，可以打开 <http://127.0.0.1:3080/?demo=1>，那里用的全是示例数据。

## 让成员工作的三种方式

| 方式 | 需要什么 | 内容发往哪里 |
| --- | --- | --- |
| **模型 API** | 一个 API Key：OpenAI、Gemini、OpenRouter、OpenCode、Kimi、DeepSeek、通义千问、智谱、豆包、硅基流动，或任何兼容 Chat Completions 的服务；本机的 Ollama、LM Studio 不需要 Key | 你为这位成员选择的模型服务 |
| **本机 Pi** | 在 Pi 的「设置」里安装一次 Pi 运行环境（或运行 `npm run pi:install`），再选模型：正在运行的 Ollama / LM Studio，或一个 GGUF 文件（需要 llama.cpp 的 `llama-server`） | 本机模型，浏览器可访问你配置的站点 |
| **你已有的 Agent** | 能连接本机办公室 MCP 的 Agent 客户端 | 由该客户端自己决定 |

- 创建成员，或点已有工作室成员的「设置」，在「模型」旁点「＋ 新连接」。选好服务商、模型并保存，可以在同一处测试和复用该连接。各服务的地址见 [支持的模型服务](docs/LOCAL-PI.md#支持的模型服务)。
- 本机 Pi 的配置见 [本机配置与使用](docs/LOCAL-PI.md)。
- 已有的 Agent 连接 `http://127.0.0.1:3080/mcp` 即可加入办公室，不需要令牌，因为这个地址只接受本机连接。可用的 17 个工具见 [工作台与 MCP](docs/WORKSPACE.md) 和 [Agent Chat 接入](docs/CHAT.md)。

## 你可以做什么

- **在项目里工作**　选成员，在「对话 → 项目任务」里挑文件夹并描述目标。本机 Pi 和支持工具调用的 API 模型可以在目录里读写文本，界面按轮次显示实际操作和逐文件差异。外部 MCP 成员通过自己的客户端认领任务并回报进度和结果。[项目任务说明](docs/WORKSPACE.md#本机项目工作台)
- **编辑成员**　点工位或成员列表后选「设置」。Pi 可以改名称、职责和工作指令。工作室成员还可切换模型连接。外部成员可改办公室显示名、职责、颜色、工位、启用状态和办公室说明。
- **群聊与成果**　在群聊里 @ 负责人，或私聊时指定交付形式。点场景下方的成果即可放大、预览和下载。点「一起群聊」返回公共频道。
- **成员文件与电脑操作**　本机 Pi 及使用 Pi 的自建成员在「文件」中提供资料上传、浏览和下载。回到「对话」可以让它制作 Office 文档、操作配置好的网页，或用 Mac 原生应用处理指定文件。其他成员的「文件」会列出它发布的成果。[成员文件与电脑操作](docs/LOCAL-PI.md#pi-的成员文件和电脑操作)

## 数据与隐私

- 办公室数据、对话、成员文件和成果默认保存在项目里的 `.office-local/`。模型密钥保存在同一目录的工作室配置里，文件只有当前用户可读，界面只显示「已配置」。
- 工作台和 MCP 只监听 `127.0.0.1`，同一网络里的其他设备连不进来。
- API 成员的模型服务会收到当前任务所需的消息。项目工具读到的文件片段、搜索结果等也会随工具调用送到所选模型服务。本机 Pi 在电脑上推理。外部 MCP 成员认领项目时会收到完整目录路径、当前要求和相关会话历史，它自己的客户端需要有权访问该目录。
- `.office-local/` 已加入 `.gitignore`，不会被提交。

## 开发

需要 Node.js 22.19 或更新版本（见 `.nvmrc`）。Three.js 已随项目提供。

```bash
npm ci
npm run check      # 语法与格式
npm test           # 单元与集成测试
npm start          # 启动本地版并打开工作台（等同双击启动器）
```

| 命令 | 作用 |
| --- | --- |
| `npm run local` | 启动本地版，不自动打开浏览器 |
| `npm run dev` | 开发预览：直接使用未打包的源文件，修改后刷新即可 |
| `npm run test:browser` | 用 Chromium 跑浏览器测试；先执行 `npx playwright-core install --only-shell chromium`，或设置 `CHROMIUM_EXECUTABLE_PATH` 指向已有的 Chrome |
| `npm run pi:install` | 安装本机 Pi 命令行工具（只需一次） |
| `npm run format` | 按 Prettier 规则格式化代码 |
| `npm run build` / `npm run preview` | 生成并预览网站版的正式构建（见下文「网站版」） |

两种启动方式都会读取项目根目录的 `.env.local`，比如用 `OFFICE_PORT` 改端口、用 `OFFICE_MODEL_FILE` 指定 Pi 模型；环境变量里已有的设置优先。

### 项目结构

| 路径 | 内容 |
| --- | --- |
| `启动 Agent Office.command` | macOS 双击启动器 |
| `scripts/local.mjs` | 本地版启动：办公室服务、成员运行、可选的本机 Pi |
| `scripts/agent-studio.mjs` / `scripts/studio-provider.mjs` | 成员档案、模型连接和兼容 API 调用 |
| `scripts/pi-*.mjs` | 本机 Pi 与 llama.cpp 的启动和收件处理 |
| `public/index.html` / `public/workspace.js` / `public/agent-studio.js` | 统一办公室、群聊与私聊、成员设置和成果 |
| `public/office.html` / `public/app.js` | 完整办公室：任务、成员、工位 |
| `public/scene.js` / `public/embed.js` | 3D 办公室 |
| `worker/` | 办公室 API 与 17 个 MCP 工具；本地版和网站版共用 |
| `tests/` | 单元、集成与浏览器测试 |
| `docs/` | 使用与接入说明 |

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交前请运行 `npm run check` 和 `npm test`；改动界面时，也请运行一次 `npm run test:browser`。

## 网站版（可选）

同一套代码也可以部署成托管网站，供在别处运行的 Agent（例如 Hermes）通过远程 MCP 接入。这需要你自己的托管项目、存储和访问认证。这部分主要供维护者使用，见 [网站版说明](docs/HOSTED.md)。

## 许可

Agent Office 采用 [MIT 许可](LICENSE)。Three.js 与 OrbitControls 同样采用 MIT 许可，见 [licenses/three-LICENSE.txt](licenses/three-LICENSE.txt)。

更新历史见 [CHANGELOG.md](CHANGELOG.md)，产品介绍见 [产品综述（Word）](<docs/Agent Office 产品综述.docx>)。

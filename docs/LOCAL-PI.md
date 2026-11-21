# 在 Mac 上运行 Agent Office 和创建 Agent

打开本机办公室，点 3D 工位或列表里的成员。右侧「对话」可以私聊、开始项目任务，「设置」用于编辑选中成员，「文件」展示成员文件或已交付成果。未选择成员时右侧显示办公室群聊。

## 接入模型 API 并创建成员

1. 点「创建 Agent」，填写显示名、职责和工作指令。在「模型」下拉框选已有连接，或点旁边的「＋ 新连接」。
2. 选择服务商，核对基础地址，填写所需的 API Key。点「获取可用模型」选型号，也可手动填模型 ID。使用自己的兼容服务时选择「自定义兼容接口」；地址支持 HTTPS 和本机回环 HTTP。
3. 保存连接。点「测试连接」会向所选型号发送一次生成请求，云端模型使用对应账户的额度。多位成员可共用一个连接。已配置本机 Pi 时，也可直接选择本机模型。
4. 点「创建并开始对话」。此后点这位成员的「设置」就能修改职责、指令和模型。

在本机 Pi 的「设置」可以改名称、职责和工作指令，新的私聊与项目轮次会读取最新设置。内置成员保留稳定 ID `pi-local`，群聊可用 `@pi-local` 点名。它的推理服务通过下方的本机启动配置指定。

已通过 MCP 登记的成员可修改办公室显示名、职责、成员颜色、空闲工位、启用状态和办公室说明。外部客户端在 `office_register_agent` 和 `office_heartbeat` 的返回值 `agent.officeNotes` 里读取说明，自行决定如何采用。模型与系统指令由对应客户端管理。

服务端使用 OpenAI 兼容的 `POST /chat/completions` 文本接口，「获取可用模型」读取 `GET /models`。模型 ID 以账户实际可调用的型号为准。

### 支持的模型服务

| 服务商 | 基础地址 | 说明 |
| --- | --- | --- |
| [OpenAI](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) | `https://api.openai.com/v1` | 需要 OpenAI 开发者平台的 Key；ChatGPT 会员不含 API 额度 |
| [Google Gemini](https://ai.google.dev/gemini-api/docs/openai) | `https://generativelanguage.googleapis.com/v1beta/openai` | Google AI Studio 的 Gemini API Key |
| [OpenRouter](https://openrouter.ai/docs/guides/features/compatibility) | `https://openrouter.ai/api/v1` | 一个 Key 调用多家模型，包括 Claude |
| [OpenCode（Zen）](https://opencode.ai/docs/zen/) | `https://opencode.ai/inference/openai/v1` | 只能用走 Chat Completions 的模型，如 GLM、Kimi、DeepSeek；旧地址 `https://opencode.ai/zen/v1` 也能识别 |
| [Kimi 国际站](https://platform.kimi.ai/docs/api/chat) | `https://api.moonshot.ai/v1` | 与国内站的 Key 互不通用 |
| [DeepSeek](https://api-docs.deepseek.com/) | `https://api.deepseek.com` | |
| [Kimi（月之暗面）](https://platform.kimi.com/docs/api/chat) | `https://api.moonshot.cn/v1` | 国内站 |
| [通义千问（阿里云百炼）](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 北京地域；其他地域或业务空间专属域名请用控制台给出的地址 |
| [智谱 GLM](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction) | `https://open.bigmodel.cn/api/paas/v4` | |
| [豆包（火山方舟）](https://www.volcengine.com/docs/82379/1330626) | `https://ark.cn-beijing.volces.com/api/v3` | 模型 ID 可填推理接入点 ID（ep- 开头） |
| [硅基流动](https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions) | `https://api.siliconflow.cn/v1` | 国际站账号用 `https://api.siliconflow.com/v1` |
| [Ollama](https://docs.ollama.com/api/openai-compatibility) | `http://127.0.0.1:11434/v1` | 本机服务，不需要 Key；先 `ollama pull` 下载模型 |
| [LM Studio](https://lmstudio.ai/docs/developer/openai-compat) | `http://127.0.0.1:1234/v1` | 本机服务，不需要 Key；在 Developer 页面启动服务 |

预设列表在 `public/model-providers.js`。「获取可用模型」会跳过模型列表里标明只支持其他接口（如向量、图片、Responses、Messages）的条目。

档案和模型凭证保存在当前本地办公室数据目录的 `studio/profiles.json`，文件权限为 0600。服务器会向配置的服务发送角色指令和该次推理需要的消息。设置页只显示密钥是否已配置。编辑原连接时，密钥框留空会沿用现有密钥。要清除密钥，请勾选「保存时清除已有密钥」并保存。更换服务主机时，请输入新主机的密钥，或明确清除已有密钥。

### 用量

工作室成员的「设置」会显示累计用量：请求次数、输入和输出 tokens，数字以服务商在每次回复中返回的为准，记录在数据目录的 `studio/usage.json`。没有返回用量的服务不计数；本机 Pi 不统计。

### 停用成员与移除连接

在工作室成员的「设置」里点「停用成员」会停止本地运行并暂停当前任务。外部成员的「在办公室启用此成员」控制它能否认领工作，停用会暂停它在办公室排队和执行中的任务。外部客户端中已经开始的本机操作由该客户端控制。再次启用后可继续派工。成员资料、历史对话和成果保存在本机，重启后仍可查看。

要移除一个模型连接，选它并点「编辑所选连接」，再点「移除连接…」确认。连接和对应的本机密钥会一起移除。如有其他成员引用，先到相应成员的设置里改选模型并保存。

### 发布共享成果

在私聊或群聊输入框选择「共享文档」「共享表格」「共享图表」或「交互 HTML」。例如，选择共享表格并输入“按版本、改动、负责人三列整理这些发布记录”，再贴入记录。群聊中请点名成员。任务标题或详情的开头也可写 `/visual table` 等指令。私聊发起的共享成果同样对整个办公室可见。

交付后点回复里的成果卡片或打开「成果」，可下载文档 Markdown、表格 CSV、图表数据 CSV 或可离线打开的隔离 HTML。「执行记录」可按成员查看发布完成或生成失败的记录。详见[工作台使用说明](WORKSPACE.md)。

## 启动

本地版需要 Node.js 22.19 或更新版本；版本不够时，启动器会直接提示。

- **Mac**：双击项目根目录的「启动 Agent Office.command」。第一次和依赖更新后，它会自动运行 `npm ci`；然后启动办公室，并在浏览器打开工作台。关闭终端窗口或按 Ctrl+C 即停止。重复双击不会再启动一份，而是打开已在运行的工作台。
- **命令行**：先运行 `npm ci`，再运行 `npm start`（启动并打开浏览器），或 `npm run local`（只启动，不打开浏览器）。

两种方式都会读取项目根目录的 `.env.local`，环境变量里已有的设置优先。默认地址是 <http://127.0.0.1:3080/>，`.env.local` 中的 `OFFICE_PORT` 可以指定端口；设置 `OFFICE_OPEN=0` 可以不自动打开浏览器。

### 在设置里选择 Pi 的模型

运行一次 `npm run pi:install` 安装 Pi CLI 后，不必编辑 `.env.local`：点办公室里的「Pi（本机）」→「设置」，在「本机模型」里可以看到：

- Pi 运行环境、正在运行的 Ollama / LM Studio（及其模型）、`llama-server` 是否已就绪；
- 「本机正在运行的模型服务」：直接选 Ollama 或 LM Studio 里的模型；
- 「GGUF 模型文件」：填写完整路径，或从 LM Studio、llama.cpp 常用模型文件夹里找到的文件中选择。

点「启动 Pi」后，Pi 会在原处加载模型并上线，不需要重启办公室。选择保存在数据目录的 `studio/pi-model.json`（权限 0600），下次启动自动沿用；「停用本机模型」会停止 Pi 和它启动的推理服务。`.env.local` 里设置了 `OFFICE_MODEL_FILE` 或 `OFFICE_MODEL_URL` 时以它为准，设置页只显示当前配置。

如果检测到 Ollama 或 LM Studio 正在运行，办公室还会在空群聊和 Pi 的私聊里提供「用本机 Ollama 创建成员」和「让 Pi 使用本机 Ollama」两个一键入口。前者创建的是使用该服务的 API 成员，不需要 Pi CLI。

### 用 .env.local 配置

若还希望在本机运行 Pi，安装 Pi CLI。

```sh
npm run pi:install
```

此安装步骤只需执行一次。将下面两行写入项目根目录的 `.env.local`，把模型路径换成自己的 GGUF。使用 Homebrew 安装的 llama.cpp 可提供 `llama-server`。也可以通过 `OFFICE_LLAMA_BIN` 指定它的可执行文件。

```dotenv
OFFICE_PORT=3081
OFFICE_MODEL_FILE="/absolute/path/to/model.gguf"
```

```sh
npm run local
```

打开终端打印的工作台地址。以上配置对应 <http://127.0.0.1:3081/>。首次载入大模型可能需要几十秒。按 Ctrl+C 可同时停止工作台、Pi 和这里启动的推理服务。聊天、任务和成果保存在 `.office-local/pi/office/`，下次启动会继续使用。若启动前还需指定其他数据目录，可以设置 `OFFICE_DATA_DIR`。直接运行 `npm run dev` 可继续使用原有开发预览。

## 已有本机推理服务

如果已经在本机运行 llama.cpp、LM Studio 或其他兼容 OpenAI Chat Completions 的服务，用以下两项替换 `OFFICE_MODEL_FILE`。`OFFICE_MODEL_ID` 填写服务的 `/v1/models` 实际列出的 ID。这个模式只连接回环地址，退出办公室后已有推理服务继续运行。

```dotenv
OFFICE_MODEL_URL=http://127.0.0.1:8080/v1
OFFICE_MODEL_ID=my-local-model
```

如推理服务需要 API 密钥，可在同一份本机配置设置 `OFFICE_MODEL_API_KEY`。自行启动 GGUF 时，模型服务默认使用 8098 端口，可通过 `OFFICE_MODEL_PORT` 更改。Pi CLI 默认使用项目内安装的版本，也可以用 `OFFICE_PI_BIN` 指向兼容的可执行文件。

## Pi 的成员文件和电脑操作

本机 Pi 和使用「Pi · 本机模型」的自建成员各有一个文件目录。私聊的普通消息与分配给该成员的普通任务可以调用文档和浏览器工具。群聊、共享 Visual 和远程共享办公室沿用文本工作流程，不加载这些成员工具。API 和外部成员的「文件」列出它们发布到办公室的成果。项目目录是在「对话 → 项目任务」里另行选择的文件夹，本机 Pi 和支持工具调用的 API 成员可以在那里修改文本代码。[项目操作与数据去向](WORKSPACE.md#本机项目工作台)

1. 选中目标 Pi，在右侧打开「文件」。可以进入子目录、返回上一级或刷新列表。
2. 点击「上传文件」选择资料。每份文件最大 16 MiB，上传到当前目录。同名文件会提示改名重传。
3. 回到私聊，发送具体操作和相对路径。比如“读取 本周/会议记录.txt，按负责人和截止日期整理成 待办.xlsx”。也可以从「用这些文件给 Pi 派活」选择示例再修改。
4. Pi 回复后，回到「文件」刷新并下载。默认存储位置是 `.office-local/pi/office/files/<成员 ID>/`。配置 `OFFICE_DATA_DIR` 时，使用对应数据目录下的 `files/<成员 ID>/`。

### 处理文档

| 文件 | 能做的事 |
| --- | --- |
| DOCX | 读取正文和表格，按段落生成新的 Word 文档。 |
| XLSX、CSV、TSV | 读取表格数据，按行列生成表格。 |
| PPTX | 读取幻灯片文本，按逐页标题和正文生成演示文稿。 |
| PDF | 将正文生成可搜索的 A4 PDF，长文会自动分页。也可提取已有 PDF 的文字层。扫描件可先用 OCR 生成可搜索 PDF。 |
| UTF-8 文本 | 读取和写入 TXT、Markdown、HTML、CSS 等文件。 |

文件操作需要 Python 3。DOCX、XLSX、PPTX 依次使用可选的 `python-docx`、`openpyxl`、`python-pptx`。生成 PDF 使用 `reportlab`，读取 PDF 使用 `pypdf`。工具会尝试系统 Python 和本机已有的 Codex Python 环境。需要其他解释器时，在 `.env.local` 给 `OFFICE_DOCUMENT_PYTHON` 填写已装好相应库的 Python 可执行文件绝对路径，重启办公室即可。文档生成默认新建文件，明确要求整份替换时可覆盖原件。

如需在私聊或普通任务中检索成员目录以外的本机资料，可以显式设置 `OFFICE_PI_READ_TOOLS=1` 并重启。这个选项会开放 Pi 内置的 `read`、`grep`、`find`、`ls`，读取范围可达当前用户有权访问的主机文件。默认仅使用上面的成员目录。

### 操作网页和 Mac 应用

- **网页**　在成员目录上传或生成 HTML 及配套资源，再发“请打开 本周/表单.html，填写姓名为小林，保存截图为 表单结果.png”。Pi 使用独立的 Chrome/Chromium 会话，可以读取页面、点击、填表、选择选项、滚动并保存 PNG。默认从成员目录离线加载资源。可用 `CHROMIUM_EXECUTABLE_PATH` 指定本机浏览器的可执行文件。
- **指定网站**　如需要在自己的站点上操作，在 `.env.local` 设置 `OFFICE_BROWSER_ORIGINS` 后重启。填写完整来源，多个用逗号分隔，例如 `OFFICE_BROWSER_ORIGINS=http://127.0.0.1:5500,https://staging.example.com`。支持 HTTPS 和本机回环 HTTP，非默认端口要写明。访问时仅请求当前来源的资源，切换来源会打开新的浏览器会话。
- **Mac 原生应用**　在私聊或任务中点名要用的程序，例如“请在访达中显示 待办.xlsx”“请在预览中打开 合同.pdf”或“请在文本编辑中打开 说明.txt，追加一行『已校对』并保存”。访达可以定位已有文件，预览可以打开 PDF 或图片，文本编辑支持打开、读取和追加保存 TXT、MD、CSV。读取或追加文本可能需要在「系统设置 → 隐私与安全性 → 自动化」里允许启动办公室的应用控制文本编辑。

Pi 保留最近几轮私聊供追问。任务缺少材料或执行受阻时，Pi 可在任务里说明原因并暂停。

[Pi 官方项目（MIT）](https://github.com/earendil-works/pi) · [llama.cpp 官方项目](https://github.com/ggml-org/llama.cpp)

## 保留远程 Hermes 接入

常规启动使用本机磁盘，Pi 在这里接单，Hermes 继续使用原有远程办公室。本地版仅保留远程 Hermes 接入配置，默认启动不会使用远程凭证或同步历史。模型连接和本机成员设置在本机办公室内管理。[Hermes 接入](HERMES.md)

若以后明确需要在同一间办公室协作，先核对站点归属，再把 `OFFICE_REMOTE_ORIGIN` 设为该站点的 HTTPS 根地址，把站点对应的服务凭证设为 `AGENT_OFFICE_TOKEN`。这两项可放在已被 Git 忽略的 `.env.local` 中。退出原来的本地实例，再运行：

```sh
npm run local -- --shared
```

共享模式下，浏览器打开的仍是本机地址，Pi 在本机推理。服务进程用凭证访问指定远程办公室，Pi 的回复、群聊和任务结果写入该办公室。既有本地记录留在本机。只有本机服务端使用站点凭证。旧版远程办公室只接受内置成员图标，Pi 会使用兼容图标，成员名仍为「Pi（本机）」，档案显示实际推理模型。

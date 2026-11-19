# 在 Mac 上运行 Agent Office 和创建 Agent

打开本机工作台，选「Pi（本机）」即可私聊。群聊里可以用 `@pi-local` 点名它，在「进入空间 → 任务」里可以为它派发任务。Pi 会登记为 `pi-local`，处理发给自己的消息和任务，执行期间持续上报心跳。

## 接入模型 API 并创建成员

1. 在本机工作台打开「创建 Agent → 模型连接」。选择 DeepSeek、OpenAI 或自定义兼容服务，填写连接名称、基础 URL 和该服务所需的 API Key。可使用 HTTPS 或本机回环 HTTP 地址。
2. 点「获取可用模型」并选定型号，也可直接填写模型 ID。服务未提供模型列表时，手动输入账户可调用的准确 ID 即可保存。点「测试已保存连接」会向该型号发送简短的生成请求，云端调用使用对应账户的额度。多位成员可共用一个连接。
3. 回到「Agent 设置」，填写名称、职责和工作指令，并选择刚才保存的连接。也可以选择已经就绪的「Pi · 本机模型」。
4. 点击「创建并开始对话」后发送第一条私聊。在群里可以点名该成员，也可以在任务页把任务交给它。下次打开工作室，选择已创建的档案即可修改职责、指令或模型。

服务端使用 OpenAI 兼容的 `POST /chat/completions` 文本接口。OpenAI 默认基础地址是 `https://api.openai.com/v1`，DeepSeek 是 `https://api.deepseek.com`。模型 ID 以账户实际可调用的型号为准。[DeepSeek 接口文档](https://api-docs.deepseek.com/) · [OpenAI 接口文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)

档案和模型凭证保存在当前本地办公室数据目录的 `studio/profiles.json`，文件权限为 0600。服务器会向配置的服务发送角色指令和该次推理需要的消息。设置页只显示密钥是否已配置。编辑原连接时，密钥框留空会沿用现有密钥。要清除密钥，请勾选「保存时清除已有密钥」并保存。更换服务主机时，请输入新主机的密钥，或明确清除已有密钥。

### 停用成员与移除连接

在「Agent 设置」选已有档案并点「停用 Agent」。成员停止接单，执行中的任务转为「已暂停」，对话、待办和已交付成果仍可查看。重启办公室后成员继续停用，可随时修改档案。点「启用 Agent」可重新接单。要恢复之前已暂停的任务，再到任务页点击对应的「继续」。

要删除一个模型连接，在「模型连接」选中它，点「移除连接…」并确认。连接和对应的本机密钥将一起移除。已停用和正在运行的成员都会占用各自的连接。若提示仍被使用，先在这些成员的设置里改选模型并保存。

### 发布共享成果

在私聊或群聊输入框选择「共享文档」「共享表格」「共享图表」或「交互 HTML」。例如，选择共享表格并输入“按版本、改动、负责人三列整理这些发布记录”，再贴入记录。群聊中请点名成员。任务也支持在标题开头写 `/visual table` 等指令。私聊发起的共享成果同样对整个办公室可见。

交付后点回复里的成果卡片或打开「成果」，可下载文档 Markdown、表格 CSV、图表数据 CSV 或可离线打开的隔离 HTML。「执行记录」可按成员查看发布完成或生成失败的记录。详见[工作台使用说明](WORKSPACE.md)。

## 启动

本地启动器需要 Node.js 22.19 或更新版本。在项目根目录运行 `npm ci` 安装办公室依赖。如果只使用模型 API，接着运行 `npm run local` 即可；默认地址是 <http://127.0.0.1:3080/>。`.env.local` 中的 `OFFICE_PORT` 可以指定端口。

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

## Pi 能做什么

默认启用文本推理。Pi 可以回答私聊、回复用户点名、撰写和总结文本，并将派发任务的结果写回办公室。任务需要额外材料或操作权限时可返回暂停状态。Pi 保留最近几轮私聊供后续追问使用。

如果希望 Pi 读取本机文件，可以在 `.env.local` 设置 `OFFICE_PI_READ_TOOLS=1` 并重启。它将有权用 `read`、`grep`、`find` 和 `ls` 读取当前用户可访问的文件，包括项目目录外的文件。默认配置关闭文件和终端工具。

[Pi 官方项目（MIT）](https://github.com/earendil-works/pi) · [llama.cpp 官方项目](https://github.com/ggml-org/llama.cpp)

## 保留远程 Hermes 接入

常规启动使用本机磁盘，Pi 在这里接单，Hermes 继续使用原有远程办公室。本地版仅保留远程 Hermes 接入配置，默认启动不会使用远程凭证或同步历史。模型连接与创建成员的工作室仅在本机模式开放。[Hermes 接入](HERMES.md)

若以后明确需要在同一间办公室协作，先核对站点归属，再把 `OFFICE_REMOTE_ORIGIN` 设为该站点的 HTTPS 根地址，把站点对应的服务凭证设为 `AGENT_OFFICE_TOKEN`。这两项可放在已被 Git 忽略的 `.env.local` 中。退出原来的本地实例，再运行：

```sh
npm run local -- --shared
```

共享模式下，浏览器打开的仍是本机地址，Pi 在本机推理。服务进程用凭证访问指定远程办公室，Pi 的回复、群聊和任务结果写入该办公室。既有本地记录留在本机。只有本机服务端使用站点凭证。旧版远程办公室只接受内置成员图标，Pi 会使用兼容图标，成员名仍为「Pi（本机）」，档案显示实际推理模型。

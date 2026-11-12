# Agent Office · AI 办公室

一个可以让 Hermes Agent 入驻的 3D 可视化办公室。网页展示成员状态、任务进度和最近动态；Hermes 通过 MCP 领取任务、发送心跳并汇报执行结果。

- 在线办公室：<https://your-office.example>（需站点所有者登录）
- 演示模式：<https://your-office.example/?demo=1>
- [Hermes 接入步骤](docs/HERMES.md) · [部署说明](docs/DEPLOYMENT.md) · [配置模板](public/hermes-config.yaml)

## 功能

- Three.js 3D 办公室：旋转、缩放、预设视角、日夜主题和手机布局。
- 成员管理、任务分配、暂停、继续、完成以及活动记录。
- 实时模式使用云端 R2 存储，每 4 秒同步一次；并发修改使用版本号和 ETag 检查。
- 7 个 MCP 工具供 Hermes 登记、发送心跳、查询和更新任务。
- `?demo=1` 使用独立的浏览器本地演示数据，可体验模拟工作状态。

实时模式初始只有一个等待连接的 Hermes 成员。只有 Agent 实际上报才显示在线；超过 5 分钟未上报显示离线。网页负责展示与派发任务，执行工作需要你自己的 Hermes 进程。

## 本地预览与检查

需要 Node.js 22 或更新版本；静态预览示例还需要 Python 3。项目已包含 Three.js 文件，没有需要安装的 npm 依赖。

```bash
git clone https://github.com/okiexia-ui/agent-office.git
cd agent-office
npm run check
npm test
npm run build
python3 -m http.server 8080 --bind 127.0.0.1 --directory public
```

打开 <http://127.0.0.1:8080/?demo=1> 体验本地演示。这个静态服务器不提供实时 API；云端实时模式需要下述部署环境。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| `public/` | 页面、样式、交互、3D 场景和 Hermes 配置模板 |
| `public/vendor/` | Three.js 0.169.0 与 OrbitControls |
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

这是 Agent Office 2.0.0 的源码快照，对应 Sites 源提交 `95d30ccad866f5ef65b4bde62889f204a9c8ed28`。归档日期：2026-11-12。

Three.js 与 OrbitControls 使用 MIT 许可，见 [licenses/three-LICENSE.txt](licenses/three-LICENSE.txt)。本仓库未对其余项目代码另行授予开源许可。

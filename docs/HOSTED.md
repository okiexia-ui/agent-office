# 网站版（可选，供维护者参考）

Agent Office 的主要用法是 [本地版](../README.md)：Agent 在你的电脑上运行，数据保存在本机。

同一套代码也可以部署成托管网站。适合的情况是：你的 Agent（例如 Hermes）运行在另一台机器上，需要通过远程 MCP 接入；或者你想在多台设备上打开同一个办公室。网站本身不运行模型，成员必须是在别处运行、并主动连接进来的 Agent。

## 需要准备

| 项目 | 说明 |
| --- | --- |
| 托管平台 | 当前实现面向 ChatGPT Sites。部署到其他平台时，需要自己提供等效的访问认证 |
| 存储 | 名为 `BUCKET` 的 R2 存储绑定，用来保存办公室数据和成果 |
| 访问策略 | 私有站点，只允许站点所有者和获授权的服务访问 |
| 服务凭证 | 运行时密钥 `HERMES_SITE_ACCESS_TOKEN`，供远程 Agent 访问 MCP |
| 项目配置 | 把 `.openai/hosting.json` 中的 `project_id` 换成你自己的项目 |

Worker 本身没有登录系统，访问认证由托管平台的网关完成。不能把它直接作为公开服务部署。

## 构建与发布

```bash
npm ci
npm run check && npm test
npm run package    # 生成 release/agent-office-<版本>-sites.tar.gz 和 SHA256SUMS.txt
```

然后通过你的托管平台发布这个部署包，或发布 `dist/server/index.js` 与 `dist/.openai/hosting.json`。完整步骤、API 路由、数据容量和缓存策略见 [部署说明](DEPLOYMENT.md)。

## 接入远程 Agent

- Hermes 的接入步骤见 [Hermes 接入](HERMES.md)，配置模板在 `public/hermes-config.yaml`。
- 本机的 Pi 也可以到网站版接单，方法见 [本机配置与使用](LOCAL-PI.md) 中的共享模式。
- 网站版可以安装成应用，并带离线提示，见 [安装成应用](APP.md)。

**服务凭证等于办公室的钥匙**：拿到 `AGENT_OFFICE_TOKEN` 的人可以读写你的办公室，不要把它发给别人。别人想用网站版，应该部署自己的站点、使用自己的凭证。网站版目前没有多用户账号。

## 和本地版的区别

| | 本地版 | 网站版 |
| --- | --- | --- |
| 成员在哪里运行 | 这台电脑（模型 API 或本机 Pi） | 在别处运行的 Agent，通过远程 MCP 接入 |
| 数据保存在 | 本机 `.office-local/` | 托管存储 |
| 访问方式 | 只接受本机连接，不需要令牌 | 站点登录，加服务凭证 |

两边的成员、对话和成果分别保存，默认不互相同步。

# 连接 Hermes

Hermes 通过远程 MCP（Streamable HTTP）连接在线办公室。请先确保自己的 Hermes 能正常运行。

## 配置

1. 用站点所有者账号打开 <https://your-office.example>。
2. 点击页面右上角“连接 Hermes”，下载 `agent-office.env`。
3. 将文件中的 `AGENT_OFFICE_TOKEN` 一行合并到运行 Hermes 的机器的 `~/.hermes/.env`。保留文件中已有的设置。
4. 将下列配置合并到 `~/.hermes/config.yaml`，保留已有的 `mcp_servers` 项目：

```yaml
mcp_servers:
  agent_office:
    url: "https://your-office.example/api/hermes/mcp"
    headers:
      OAI-Sites-Authorization: "Bearer ${AGENT_OFFICE_TOKEN}"
```

5. 重启 Hermes，或在 Hermes 会话中执行 `/reload-mcp`。

`${AGENT_OFFICE_TOKEN}` 是环境变量引用，不要把真实密钥写进 YAML 模板或提交到 Git。这个凭证允许访问私有站点，应只保存在你的 Hermes 密钥配置中。

原生 `/mcp` 入口使用 Sites 的 OAuth 认证。以上服务密钥接入必须使用 `/api/hermes/mcp`，两者不能混用。

## 第一次连接

把这段话发给 Hermes：

> 连接 agent_office MCP 服务，调用 office_register_agent，用 agent_id=hermes、name=Hermes、model=Hermes 登记自己。读取办公室状态，汇报当前待办任务，等待我给出的执行指令。

注册成功后，网页会在下一次同步时显示 Hermes 在线。始终复用 `agent_id=hermes`，避免重复创建成员。

## 工作流程

1. 调用 `office_register_agent` 登记或重新连接。
2. 调用 `office_list_tasks` 查询分配给自己的任务。
3. 在获得任务执行授权后，调用 `office_claim_task` 领取任务。
4. 执行期间每 30–60 秒调用 `office_heartbeat`，通过 `office_update_task` 上报实际进度。
5. 完成时使用 `status=done`，在 `result` 中写入结果摘要；随后将心跳状态设为 `resting`。

| 工具 | 用途 |
| --- | --- |
| `office_get_state` | 查看成员、任务和最近动态 |
| `office_register_agent` | 登记或重新连接成员 |
| `office_heartbeat` | 上报真实状态和简短动态 |
| `office_list_tasks` | 按成员或任务状态查询 |
| `office_create_task` | 创建待领取任务；`request_id` 用于重试去重 |
| `office_claim_task` | 领取任务或恢复暂停的任务 |
| `office_update_task` | 上报进度、暂停或完成任务 |

成员状态：`working`、`thinking`、`resting`。任务状态：`queued`、`active`、`paused`、`done`。每名成员同时最多有一个进行中的任务。

## 排查

- **401 / 403：**检查密钥是否正确加载，URL 是否以 `/api/hermes/mcp` 结尾，请求头是否为 `OAI-Sites-Authorization`。
- **仍显示等待连接：**确认 Hermes 已成功调用 `office_register_agent`；仅在浏览器打开办公室不会代替 Agent 注册。
- **超过 5 分钟离线：**检查 Hermes 进程与心跳上报。
- **409 冲突：**重新读取状态后重试操作，不要覆盖较新的状态。
- **本地演示不能同步：**`?demo=1` 的状态仅保存在当前浏览器。

Hermes 官方参考：[MCP 配置](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference) · [CLI 命令](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)。

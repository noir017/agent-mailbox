# agent-mailbox 的 Muse 安装包

[English](README.md)

让 Meta 的 Muse 通过 [agent-mailbox](../../README.zh-CN.md) 中继接收网关发来的消息并回复。外面调不到 Muse；它云端 VM 里的 hook 轮询中继（有消息往来时每 5 秒一次，闲了一小时后每 30 秒一次），有消息就唤醒它，回复走自定义 connector 发回中继。

| 文件 | 放到（Muse 的 VM 里） |
|---|---|
| `connector/custom.agent-mailbox/`（`CONNECTOR.md`、`connector.yaml`、`bin/mailbox.py`） | `~/workspace/custom-connectors/custom.agent-mailbox/` |
| `connector/custom.agent-mailbox/config.example.json` | 同一目录，改名 `config.json`，填你的主机 |
| `hooks/agent-mailbox.sh` | `~/hooks/scripts/agent-mailbox.sh` |
| `hooks/agent-mailbox.json` | Muse 存放 hook 定义的地方（`~/hooks/scripts/` 旁边） |

VM 里要有 `python3` 和 `jq`，和它改编自的 Telegram 桥一样。

## 安装

先要有部署好的中继，并给这个 Muse 账号建好信箱（中继仓库里 `npm run new-mailbox -- <id>`）。手边留着 **agent token**，它不进聊天。

### 让 Muse 自己装

[`SETUP.md`](SETUP.md) 是写给 Muse 的分步指令：下载文件、登记凭据、`ping` 自检、出错换放法、注册 hook，最后向你汇报。把下面这段发给 Muse，换成你的中继地址：

```text
按 https://raw.githubusercontent.com/noir017/agent-mailbox/main/integrations/muse/SETUP.md 把你自己接入我的 agent-mailbox 中继。中继地址：https://mailbox.example.com 。token 我会在凭据输入框里填，不要在聊天里问我要。
```

凭据表单弹出时贴 agent token；第一次出网时批准中继主机。它汇报完，从网关发一条测试消息。

### 手动装

1. **文件**：把上面的文件交给 Muse（上传，或让它从本仓库下载），让它按表里的位置放好。`config.json` 里 `base_url` 填你的中继（`https://mailbox.example.com`），`placement` 填 `"bearer"`。
2. **凭据**：让 Muse 新建自定义 connector `custom.agent-mailbox`：服务商 `agent-mailbox`，认证 `api_key`，API 主机填中继的主机名，key 用 `Authorization: Bearer` 头发送。Muse 自己的凭据流程会弹出安全输入框要 key：agent token 贴在那里，不要贴进对话。Muse 把它存进 Secure Credentials Store，代码里只看得到 `hsurr:` 替身。
3. **出网**：第一次请求新主机时可能要你批准出网访问，只批准这一个主机。
4. **验证**：让 Muse 运行 `python3 ~/workspace/custom-connectors/custom.agent-mailbox/bin/mailbox.py ping`，应输出 `{"ok": true, "mailbox": "<id>", "role": "agent", …}`。
5. **hook**：让 Muse 按 `agent-mailbox.json` 注册 hook（间隔 5 秒；中继说还没到时间的那几次，脚本自己跳过）。从网关发一条消息：Muse 应先回一条进度，再回答案。刚装好时信箱还算闲着，第一条最多等 30 秒才被取走，之后一小时内是几秒。

### token 先试哪种放法

先试 **Authorization 头**：token 不进 URL，Muse 的请求审计和中继这边任何记 URL 的地方都不会留下它。Muse 的凭据流程能不能把 key 放进请求头，还没实测。

如果放不了，或者 `ping` 回 `HTTP 401`，换成**路径段**，也就是 Telegram 桥实测过的那种（那边是 `/bot{}`）：用 placement `url_path_segment:/agent{}` 重新连接凭据，`config.json` 里改成 `"placement": "path"`，再 `ping`。helper 会把替身原样放进路径；做了百分号编码的替身不会被替换，中继会回 401。

### 出错时

| `ping` 输出 | 含义 |
|---|---|
| `HTTP 401: unauthorized` | token 没到：`config.json` 的 placement 和登记的不一致、主机没登记，或 token 不对 |
| `HTTP 404: not found` | `base_url` 指错了（多了一段路径前缀？） |
| `redirect refused` | `base_url` 回了重定向，比如写成了 `http://` |
| `cannot reach the relay` | DNS 问题，或出网没批准 |

## 给 Muse 的规则

唤醒规则在 `hooks/agent-mailbox.json` 里。概括：每个 session 各自维护上下文；先马上发一条进度，长任务每步发一条、两条至少隔 10 秒（不能 4 分钟一条都没有）；每一轮都以 `final` 结束；收到 `cancel` 就停手并回 `final`；只有重要结果才主动发消息，且带原来的 session。

## 测试

`tests/` 在 Muse 之外跑真正的 hook 和 helper：`fake_hatch/runtime.sh` 实现了 `hook_state_get`/`hook_state_set`、`silent`、`wake`、`log`，`fake_creds/` 顶替 `dynamic_credentials`，`harness.SwapProxy` 像 Muse 出网那样把替身换成 token。`test_helper.py` 对桩中继；`test_e2e.py` 对真中继（中继仓库里 `npm run test:e2e` 会用 `wrangler dev` 起一个）。

## 署名

改编自 [telegram-muse-bridge](https://github.com/z1010223zero-pixel/telegram-muse-bridge)（MIT），见 [NOTICE](NOTICE)。

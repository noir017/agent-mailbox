# agent-mailbox

[English](README.md)

跑在 Cloudflare Workers 上的信箱中继，给只能轮询的云端 agent 用。agent 和你的网关都是中继的客户端，两边都不用开入口。

```
网关 ──POST /client/send────►┌─────────────┐◄──GET /agent…/inbox── agent（定时脚本，每 5 秒）
     ◄─GET /client/replies───│ 中继        │◄──POST /agent…/reply── （progress · final · message）
                             │ 每个信箱一个 │
                             │ Durable     │
                             │ Object      │
                             └─────────────┘
```

- 每个 agent 账号一个信箱，每个信箱两把 token：**agent** token（取消息、回消息、ping）和 **client** token（投递、取回复、取消）。配置里只放它们的 SHA-256 哈希。
- 中继里没有任何 agent 专属的东西。[`integrations/muse/`](integrations/muse/) 是 Meta Muse 的安装包（connector、hook、安装说明）。

## 协议

请求体都是 JSON；应答是 `{"ok": true, …}` 或 `{"ok": false, "error": "…"}`，配 HTTP 状态码，一律 `Cache-Control: no-store`。

### agent 侧

token 两种放法：放在第一个路径段里、紧跟 `agent`（照 Telegram `/bot<token>/` 的样子），或者用 `Authorization: Bearer <token>` 配不带 token 的 `/agent/` 前缀。两种走的是同一套路由，agent 平台能把凭据放哪就用哪种。

| 请求 | 应答 |
|---|---|
| `GET /agent<token>/ping` · `GET /agent/ping` | `{mailbox, role: "agent", pending}`，安装时验证用的无害读取 |
| `GET /agent<token>/inbox?after=<cursor>&limit=<n>` | `{messages: [{seq, session, turn, type, text, at}], cursor, poll_after}` |
| `POST /agent<token>/reply` `{session, turn?, type, text}` | `{seq}` |

- `inbox` 按从旧到新返回 `after` 之后的消息（`limit` 1–100，默认 50）。把上次应答的 `cursor` 当 `after` 传回来，就确认了它之前的全部，中继随即删掉。游标要存在能留住的地方（Muse 的 hook 存在 hook state 里）。超出信箱历史上限的游标会被当作没传，不会照它跳过新消息。
- `poll_after` 是下次 `inbox` 前要等的秒数：`ACTIVE_WINDOW_MINUTES`（60）分钟内有过消息（client 投递的或 agent 回复的都算）就是 `POLL_ACTIVE_SECONDS`（5），否则 `POLL_IDLE_SECONDS`（30）。agent 全天不停地轮询，而免费计划先用完的是每天的请求数（见[免费额度](#免费额度)）；Muse 的 hook 每 5 秒跑一次，没到时间的那几次直接跳过。代价：闲了一小时后的第一条消息，最多等 30 秒才被取走。
- 投递的 `type`：`message`（开始 `session` 的 `turn` 这一轮）或 `cancel`（停掉 `turn`）。
- 回复的 `type`：`progress`（进度，要带 `turn`）、`final`（答案，结束本轮，要带 `turn`）、`message`（文字；带本轮的 turn 就算本轮答案的一部分，不带就是给这个 session 的主动消息）。
- 回复到 client 从没开过的 session：`404 unknown session`。

### client 侧

只认 `Authorization: Bearer <client token>`。

| 请求 | 应答 |
|---|---|
| `POST /client/send` `{session, turn?, type, text}` | `{seq, turn, agent}`；`type` 为 `message`（默认）或 `cancel`；不带 `turn` 就用 seq |
| `GET /client/replies?session=<s>&after=<cursor>&limit=<n>` | `{replies: [{seq, session, turn, type, text, at}], cursor, agent}` |
| `POST /client/cancel` `{session, turn, withdraw_only?}` | `{withdrawn, seq?, agent}` |
| `GET /client/status` | `{mailbox, role: "client", agent}` |

- 同一个 `turn` 已有一条没送达的消息时，`send` 直接回那条的 `seq`（带 `duplicate: true`），不重复入队；客户端丢了应答可以放心重发。
- `replies` 和 `inbox` 一样用游标确认，范围是一个 session（不带 `session` 就是整个信箱）。
- `cancel`：agent 还没取走这一轮的消息，就直接撤回（`withdrawn: 1`，agent 永远看不到这一轮）；已经取走了，就给 agent 投一条 `cancel`（返回 `seq`）。`withdraw_only` 为 true 时只撤回、不投 cancel。
- `agent` 是 `{last_poll_at, fetched_upto, acked_upto}`：agent 上次来取的时间（毫秒时间戳，没来过为 `null`）、已交给它的最大 inbox seq、它已确认的最大 seq。`seq <= fetched_upto` 的消息就是被取走了。信箱对象在内存里时 `last_poll_at` 是准的，对象被回收后最多差一分钟。

`session`：1–128 个 `A-Z a-z 0-9 . _ : -`；`turn`：1–64 个同样字符。

### 限制

`wrangler.jsonc` 里的 vars：

| 变量 | 默认 | |
|---|---|---|
| `TTL_HOURS` | 168 | 超过这个时长没送达的消息、没读的回复会被清掉 |
| `MAX_BODY_BYTES` | 131072 | 请求体超长：`413` |
| `MAX_TEXT_CHARS` | 16000 | `text` 超长：`413`（Muse helper 会自动拆长答案） |
| `MAX_PENDING` | 200 | 单方向未读条数超了：`429` |
| `POLL_ACTIVE_SECONDS` | 5 | 信箱在用时的 `poll_after` |
| `POLL_IDLE_SECONDS` | 30 | 其余时候的 `poll_after`（不能比在用时短） |
| `ACTIVE_WINDOW_MINUTES` | 60 | 最后一条消息（任一方向）之后多久内算在用 |

## 部署

需要 Node 22.12+ 和一个 Cloudflare 账号（免费计划就够，见下文）。

```bash
npm install
npx wrangler login

# 每个 agent 账号一个信箱。两把 token 只打印这一次，外加 MAILBOXES 的值。
npm run new-mailbox -- alice
# 再加一个：把上次的 MAILBOXES 值存成文件传进去，在它基础上追加。
npm run new-mailbox -- bob mailboxes.json

npx wrangler secret put MAILBOXES     # 粘贴打印出来的 JSON
npx wrangler deploy
curl https://agent-mailbox.<你的子域>.workers.dev/health
```

- agent token 交给 agent 自己的凭据库，client token 交给网关的环境变量；两者都不进仓库、聊天和日志。`MAILBOXES` 里只有哈希；加信箱、吊销 token 就是再 `secret put` 一次。
- **自定义域名**（可选）：在 `wrangler.jsonc` 里取消 `routes` 的注释、填上你的主机名，比如 `{"pattern": "mailbox.example.com", "custom_domain": true}`，再部署一次；这个 zone 要在同一个 Cloudflare 账号下。agent 那边登记的 API 主机就是它。
- **User-Agent**：zone 开着 Cloudflare 的 Browser Integrity Check 时，没带像样 `User-Agent` 的请求（比如 Python `urllib` 的默认值）在到达 Worker 之前就被回 `403`（error 1010）。Muse 的 helper 和 fleetherd 都带了自己的；自己写客户端也要带。
- **日志**：`wrangler.jsonc` 里关了 `observability`，Worker 自己从不记 URL、请求头和请求体。但 token 放在路径里时它就在 URL 里，任何记 URL 的东西都会看到：`wrangler tail`、开了的 Workers Logs、`wrangler dev` 自己的请求日志。agent 能用 Bearer 就用 Bearer。
- 本地：把 `.dev.vars.example` 复制成 `.dev.vars`，填 `MAILBOXES`，`npm run dev`。

## 免费额度

以下价格和限额来自 Cloudflare 官方文档，**2026-11-13** 查阅（[Workers 计费][wp]、[Workers 限额][wl]、[Durable Objects 计费][dop]、[D1 计费][d1p]、[DO 生命周期][dol]）：

| Workers 免费计划 | 每天 |
|---|---|
| Worker 请求 | 100,000（超了报 1027，到 UTC 0 点恢复） |
| Worker CPU | 每次请求 10 ms |
| Durable Object 请求 | 100,000（Worker 调一次对象算一次） |
| Durable Object 时长 | 13,000 GB-s（每个对象按 128 MB 计，处理请求或不能休眠时计费） |
| SQLite 读行 / 写行 | 5,000,000 / 100,000（与 D1 相同） |
| SQLite 存储 | 共 5 GB |

任何一项超出免费额度，同类操作就报错，直到 UTC 0 点。

**每个 agent 账号**：agent 每轮询一次是一个 Worker 请求加一个对象请求。按默认间隔（一小时内有过消息就 5 秒，否则 30 秒）：

- 整天闲着：86,400 / 30 = **2,880** 次/天。
- 每在用一小时：3,600 / 5 = **720** 次，闲着时是 120 次。每天用 8 小时的账号：8 × 720 + 16 × 120 = **7,680** 次/天；全天都在用：86,400 / 5 = **17,280** 次/天。
- 网关：像 fleetherd 那样的客户端，一轮进行中每 2 秒取一次回复，两轮之间子进程还在时每 20 秒一次；正常使用每个账号约 1,000–3,000 次/天。
- 读写行：一次空轮询读 3–6 行、不写（上次轮询时间最多每分钟写一次：1,440 行/天）。最多 17,280 × 6 ≈ 104,000 行/天，对 5,000,000。
- 时长（短轮询）：对象只在处理请求的几毫秒里计费：17,280 × 10 ms × 0.128 GB ≈ **22 GB-s/天**，对 13,000（Cloudflare 把 128 MB 记作 0.128 GB）。

所以**瓶颈是请求数**。每天用 8 小时的账号约 7,680 + 3,000 ≈ 10,700 次，100,000 能撑**约 9 个**；大部分时间闲着的账号只要 2,880 次加网关那一侧。最差是每个账号全天都在用：100,000 / (17,280 + 3,000) → **4 个**。如果固定每 5 秒一次，不管用不用，每个账号都是 17,280 次。

**为什么用短轮询**：长轮询让请求、也就是对象一直挂着：86,400 s × 0.128 GB = **每账号 11,059 GB-s/天**，13,000 GB-s 只够 1 个账号。短轮询的代价是新消息最多等一个轮询间隔（5 秒，闲着时 30 秒）才被取走。

**为什么用 Durable Object 而不是 D1**：这个量级两者都免费。每个信箱一个对象就是单写者，序号和"取走没有"不用事务；agent 上次轮询的时间可以放内存里，不用每次轮询写一行（否则每账号 17,280 次写/天，一个账号就吃掉六分之一的写额度）。

Workers 付费计划（$5/月）每月含 1,000 万次 Worker 请求和 100 万次对象请求；全天在用的账号每月 17,280 × 30 = 518,400 次对象请求，大约 2 个这样的账号不超出，之后每百万次 $0.15。

[wp]: https://developers.cloudflare.com/workers/platform/pricing/
[wl]: https://developers.cloudflare.com/workers/platform/limits/
[dop]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[d1p]: https://developers.cloudflare.com/d1/platform/pricing/
[dol]: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/

## 客户端

- **agent**：[`integrations/muse/`](integrations/muse/)，Muse 的自定义 connector（`ping`、`inbox`、`reply`）、5 秒一次的 hook 和唤醒规则。
- **网关**：会说 client 侧协议的都行，[fleetherd](https://github.com/noir017/fleetherd) 的 `api-agent mailbox` 是其中一个。

## 测试

```bash
npm test             # 单测：基于 node:sqlite 的存储、路由、配置
npm run typecheck
npm run test:muse    # Muse helper 和 hook 对桩中继
npm run test:e2e     # 本地 wrangler dev + HTTP 检查 + Muse 安装包端到端（不连 Cloudflare）
```

Muse 的测试用假 Hatch 运行时（`integrations/muse/tests/fake_hatch/runtime.sh`）跑真正的 `hook.sh`，真正的 helper 前面挡一个模拟 Muse 凭据替换的代理。

## 许可

MIT。`integrations/muse/` 改编自 [telegram-muse-bridge](https://github.com/z1010223zero-pixel/telegram-muse-bridge)（MIT），见[它的声明](integrations/muse/NOTICE)。

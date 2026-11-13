# agent-mailbox

[中文](README.zh-CN.md)

A mailbox relay on Cloudflare Workers for cloud agents that can only poll. The agent and your
gateway are both clients of the relay; neither has to accept a connection.

```
gateway ──POST /client/send────►┌─────────────┐◄──GET /agent…/inbox── agent (cron/hook, every 5 s)
        ◄─GET /client/replies───│ relay       │◄──POST /agent…/reply── (progress · final · message)
                                │ 1 Durable   │
                                │ Object per  │
                                │ mailbox     │
                                └─────────────┘
```

- One mailbox per agent account, each with two tokens: the **agent** token (fetch, reply, ping)
  and the **client** token (send, fetch replies, cancel). Only their SHA-256 hashes are configured.
- Nothing agent-specific in the relay. [`integrations/muse/`](integrations/muse/) is the package
  for Meta's Muse (connector, hook, install guide).

## Protocol

All bodies are JSON; every answer is `{"ok": true, …}` or `{"ok": false, "error": "…"}` with an
HTTP status. Answers are `Cache-Control: no-store`.

### Agent side

The token goes either in the first path segment, right after `agent` (the shape of Telegram's
`/bot<token>/`), or in `Authorization: Bearer <token>` with the plain `/agent/` prefix. Both open
the same routes; use whichever your agent platform can place a credential in.

| Request | Answer |
|---|---|
| `GET /agent<token>/ping` · `GET /agent/ping` | `{mailbox, role: "agent", pending}` — a harmless read for setup checks |
| `GET /agent<token>/inbox?after=<cursor>&limit=<n>` | `{messages: [{seq, session, turn, type, text, at}], cursor, poll_after}` |
| `POST /agent<token>/reply` `{session, turn?, type, text}` | `{seq}` |

- `inbox` returns messages after `after`, oldest first (`limit` 1–100, default 50). Passing the
  `cursor` of the previous answer as `after` confirms everything up to it, and the relay deletes
  it. Keep the cursor somewhere that survives (the Muse hook keeps it in its hook state). A cursor
  beyond anything the mailbox ever held is ignored rather than trusted.
- `poll_after` is how many seconds to wait before the next `inbox`: `POLL_ACTIVE_SECONDS` (5) while
  a message went either way — sent by the client or replied by the agent — within
  `ACTIVE_WINDOW_MINUTES` (60), else `POLL_IDLE_SECONDS` (30). An agent polls around the clock, and
  requests per day are what the free plan runs out of (see [Free plan](#free-plan)); the Muse hook
  ticks every 5 s and skips the ticks before it is due. The cost: after an idle hour, the first
  message waits up to 30 s to be picked up.
- Inbox `type`: `message` (starts turn `turn` of `session`) or `cancel` (stop turn `turn`).
- Reply `type`: `progress` (a status line, needs `turn`), `final` (the answer, ends the turn,
  needs `turn`) or `message` (text; with the turn's id it is part of that turn's answer, without
  one it is an unprompted message for the session).
- A reply to a session the client never opened is `404 unknown session`.

### Client side

`Authorization: Bearer <client token>` only.

| Request | Answer |
|---|---|
| `POST /client/send` `{session, turn?, type, text}` | `{seq, turn, agent}` — `type` `message` (default) or `cancel`; no `turn` → the seq as text |
| `GET /client/replies?session=<s>&after=<cursor>&limit=<n>` | `{replies: [{seq, session, turn, type, text, at}], cursor, agent}` |
| `POST /client/cancel` `{session, turn, withdraw_only?}` | `{withdrawn, seq?, agent}` |
| `GET /client/status` | `{mailbox, role: "client", agent}` |

- `send` with a `turn` that already has an undelivered message answers with that message's `seq`
  (`duplicate: true`) instead of queueing it twice, so a client can retry a send it lost the answer to.
- `replies` works like `inbox`, scoped to one session (or the whole mailbox without `session`).
- `cancel` withdraws the turn's message if the agent has not fetched it yet (`withdrawn: 1`; the
  agent never sees the turn). Otherwise it queues a `cancel` for the agent (`seq`), unless
  `withdraw_only` is true.
- `agent` is `{last_poll_at, fetched_upto, acked_upto}`: when the agent last polled (epoch ms,
  `null` if never), the highest inbox seq it has been handed, and the highest it confirmed. A
  message with `seq <= fetched_upto` has been picked up. `last_poll_at` is exact while the
  mailbox's object is in memory and at most a minute stale after it was evicted.

`session`: 1–128 of `A-Z a-z 0-9 . _ : -`. `turn`: 1–64 of the same.

### Limits

Worker vars in `wrangler.jsonc`:

| Var | Default | |
|---|---|---|
| `TTL_HOURS` | 168 | undelivered messages and unread replies older than this are dropped |
| `MAX_BODY_BYTES` | 131072 | larger request bodies: `413` |
| `MAX_TEXT_CHARS` | 16000 | longer `text`: `413` (the Muse helper splits long answers) |
| `MAX_PENDING` | 200 | more unread items per direction: `429` |
| `POLL_ACTIVE_SECONDS` | 5 | `poll_after` while the mailbox is in use |
| `POLL_IDLE_SECONDS` | 30 | `poll_after` otherwise (not shorter than the active one) |
| `ACTIVE_WINDOW_MINUTES` | 60 | how long after the last message, either way, the mailbox is in use |

## Deploy

Requires Node 22.12+ and a Cloudflare account (the free plan is enough, see below).

```bash
npm install
npx wrangler login

# One mailbox per agent account. Prints both tokens once, and the MAILBOXES value.
npm run new-mailbox -- alice
# Next ones: pass the previous MAILBOXES value as a file to extend it.
npm run new-mailbox -- bob mailboxes.json

npx wrangler secret put MAILBOXES     # paste the JSON it printed
npx wrangler deploy
curl https://agent-mailbox.<your-subdomain>.workers.dev/health
```

- Hand the agent token to the agent's own credential store, and the client token to the
  gateway's environment. Neither goes into this repository, a chat or a log. `MAILBOXES` holds
  hashes only; changing it (a new mailbox, a revoked token) is another `secret put`.
- **Custom domain** (optional): uncomment `routes` in `wrangler.jsonc` with your hostname, e.g.
  `{"pattern": "mailbox.example.com", "custom_domain": true}`, and deploy again; the zone must be
  on the same Cloudflare account. The agent registers that hostname as its API host.
- **User-Agent.** A zone with Cloudflare's Browser Integrity Check on answers a request without a
  browser-like or custom `User-Agent` — Python's `urllib` default among them — with `403` (error
  1010) before the Worker sees it. The Muse helper and fleetherd send their own; a client you
  write should too.
- **Logs.** `observability` is off in `wrangler.jsonc`, and the Worker never logs a URL, a header
  or a body. An agent that puts its token in the path does put it in the URL, so anything that
  records URLs will see it: `wrangler tail`, Workers Logs if you turn them on, and `wrangler dev`'s
  own request lines. Prefer the Bearer form where the agent can use it.
- Local: copy `.dev.vars.example` to `.dev.vars`, fill in `MAILBOXES`, `npm run dev`.

## Free plan

Prices and limits from Cloudflare's docs, read **2026-11-13** ([Workers pricing][wp],
[Workers limits][wl], [Durable Objects pricing][dop], [D1 pricing][d1p], [DO lifecycle][dol]):

| Workers Free | per day |
|---|---|
| Worker requests | 100,000 (then error 1027 until 00:00 UTC) |
| Worker CPU | 10 ms per request |
| Durable Object requests | 100,000 (each Worker → object call is one) |
| Durable Object duration | 13,000 GB-s (128 MB per object, billed while it handles a request or cannot hibernate) |
| SQLite rows read / written | 5,000,000 / 100,000 (same for D1) |
| SQLite storage | 5 GB total |

Over any free limit, further operations of that kind fail until 00:00 UTC.

**Per agent account.** Each agent poll is one Worker request and one object request. With the
default intervals (5 s within an hour of a message, 30 s otherwise):

- Idle all day: 86,400 / 30 = **2,880** requests/day.
- Each hour in use: 3,600 / 5 = **720** instead of 120. An account in use 8 hours a day:
  8 × 720 + 16 × 120 = **7,680**/day. In use around the clock: 86,400 / 5 = **17,280**/day.
- Gateway: a fleetherd-style client polls replies every 2 s during a turn and every 20 s between
  turns while its process is alive — about 1,000–3,000/day for an account in ordinary use.
- Rows: an empty poll reads 3–6 rows and writes none (the poll time is written at most once a
  minute: 1,440 rows/day). At most 17,280 × 6 ≈ 104,000 reads/day against 5,000,000.
- Duration, short polling: an object is billed only while a request runs, a few milliseconds:
  17,280 × 10 ms × 0.128 GB ≈ **22 GB-s/day** against 13,000 (Cloudflare counts 128 MB as 0.128 GB).

So **requests are the limit**. An account in use 8 hours a day costs about 7,680 + 3,000 ≈ 10,700
requests, so 100,000 covers **about 9 such accounts**; accounts that are mostly idle cost 2,880
plus their gateway side. The floor is accounts in use around the clock: 100,000 / (17,280 + 3,000)
→ **4 accounts**. A fixed 5 s poll would cost every account 17,280 whether or not anyone used it.

**Why short polling.** A long poll keeps the request — and so the object — in flight the whole
time: 86,400 s × 0.128 GB = **11,059 GB-s/day per account**, so 13,000 GB-s covers one account.
The agent waits up to one poll interval (5 s, or 30 s when idle) for a new message instead.

**Why a Durable Object and not D1.** Both are free at this size. One object per mailbox is a
single writer, so sequence numbers and "picked up yet" need no transactions, and the agent's last
poll time can live in memory instead of costing a row write on every poll (17,280 writes/day per
account would otherwise eat a sixth of the daily write budget each).

The Workers Paid plan ($5/month) includes 10 million Worker requests and 1 million object
requests per month; an account in use around the clock makes 17,280 × 30 = 518,400 object requests
a month, so about two such accounts fit before object requests cost $0.15 per extra million.

[wp]: https://developers.cloudflare.com/workers/platform/pricing/
[wl]: https://developers.cloudflare.com/workers/platform/limits/
[dop]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[d1p]: https://developers.cloudflare.com/d1/platform/pricing/
[dol]: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/

## Clients

- **Agent**: [`integrations/muse/`](integrations/muse/) — a Muse custom connector (`ping`,
  `inbox`, `reply`), a 5-second hook, and the wake rules.
- **Gateway**: anything that speaks the client side. [fleetherd](https://github.com/noir017/fleetherd)'s
  `api-agent mailbox` backend is one.

## Tests

```bash
npm test             # unit tests: store over node:sqlite, router, config
npm run typecheck
npm run test:muse    # the Muse helper and hook against a stub relay
npm run test:e2e     # wrangler dev (local only) + HTTP checks + the Muse package end to end
```

The Muse tests run the real `hook.sh` under a fake Hatch runtime
(`integrations/muse/tests/fake_hatch/runtime.sh`) and the real helper behind a proxy that plays
Muse's credential swap.

## License

MIT. `integrations/muse/` is adapted from
[telegram-muse-bridge](https://github.com/z1010223zero-pixel/telegram-muse-bridge) (MIT); see
[its notice](integrations/muse/NOTICE).

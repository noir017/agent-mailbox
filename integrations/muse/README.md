# agent-mailbox for Muse

[中文](README.zh-CN.md)

Lets Meta's Muse take messages from your gateway and answer them through an
[agent-mailbox](../../README.md) relay. Muse cannot be called from outside; a hook in its cloud VM
polls the relay every 5 seconds and wakes it when a message is waiting, and a custom connector
posts the replies back.

| File | Goes to (in Muse's VM) |
|---|---|
| `connector/custom.agent-mailbox/` (`CONNECTOR.md`, `connector.yaml`, `bin/mailbox.py`) | `~/workspace/custom-connectors/custom.agent-mailbox/` |
| `connector/custom.agent-mailbox/config.example.json` | the same folder, as `config.json`, with your host |
| `hooks/agent-mailbox.sh` | `~/hooks/scripts/agent-mailbox.sh` |
| `hooks/agent-mailbox.json` | where Muse keeps hook definitions (beside `~/hooks/scripts/`) |

The VM needs `python3` and `jq`, as the Telegram bridge this is adapted from does.

## Install

You need a deployed relay and a mailbox for this Muse account (`npm run new-mailbox -- <id>` in the
relay repository). Keep the **agent token** at hand; it never goes into the chat.

1. **Files.** Give Muse the files above — upload them, or ask it to fetch them from this
   repository — and have it place them as listed. In `config.json` set `base_url` to your relay
   (`https://mailbox.example.com`) and `placement` to `"bearer"`.
2. **Credential.** Ask Muse to create the custom connector `custom.agent-mailbox`: provider
   `agent-mailbox`, auth `api_key`, API host your relay's hostname, the key sent as an
   `Authorization: Bearer` header. Muse's own credential flow asks for the key in its secure form:
   paste the agent token there, not into the conversation. Muse keeps it in its Secure Credentials
   Store and its code only ever sees an `hsurr:` placeholder.
3. **Network.** The first request to the new host may need your approval for outbound access.
   Approve it for that host only.
4. **Check.** Ask Muse to run `python3 ~/workspace/custom-connectors/custom.agent-mailbox/bin/mailbox.py ping`.
   It should print `{"ok": true, "mailbox": "<id>", "role": "agent", …}`.
5. **Hook.** Ask Muse to register the hook from `agent-mailbox.json` (5-second interval). Send a
   message from the gateway: within a few seconds Muse should send a progress line, then the answer.

### Which token placement first

Try the **Authorization header** first: the token then stays out of URLs, which Muse's request
audit and anything on the relay side that records URLs would otherwise hold. Whether Muse's
credential flow can place a key in a header has not been tested.

If it cannot, or `ping` answers `HTTP 401`, switch to the **path segment**, the shape the Telegram
bridge verified (`/bot{}` there): reconnect the credential with placement
`url_path_segment:/agent{}` and set `"placement": "path"` in `config.json`, then `ping` again. The
helper puts the placeholder into the path as it is; a percent-encoded placeholder is not swapped
and the relay answers 401.

### When something fails

| `ping` says | Meaning |
|---|---|
| `HTTP 401: unauthorized` | the token did not arrive: placement in `config.json` differs from the registration, the host is not registered, or the token is wrong |
| `HTTP 404: not found` | `base_url` points somewhere else (a path prefix too many?) |
| `redirect refused` | `base_url` answers with a redirect, e.g. `http://` instead of `https://` |
| `cannot reach the relay` | DNS, or outbound access not approved |

## What Muse is told

`hooks/agent-mailbox.json` carries the wake rules. In short: one context per session; a progress
line right away and then at most every 10 seconds on longer work (never 4 minutes without one);
every turn ends with a `final`; a `cancel` stops the turn and gets a `final`; unprompted messages
only for important results, with the original session.

## Tests

`tests/` runs the real hook and helper outside Muse: `fake_hatch/runtime.sh` implements
`hook_state_get`/`hook_state_set`, `silent`, `wake` and `log`, `fake_creds/` stands in for
`dynamic_credentials`, and `harness.SwapProxy` swaps the placeholder for the token like Muse's
egress. `test_helper.py` uses a stub relay; `test_e2e.py` a real one (`npm run test:e2e` in the
relay repository starts it under `wrangler dev`).

## Credit

Adapted from [telegram-muse-bridge](https://github.com/z1010223zero-pixel/telegram-muse-bridge)
(MIT); see [NOTICE](NOTICE).

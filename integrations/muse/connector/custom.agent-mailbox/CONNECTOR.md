# Agent Mailbox

- `custom.agent-mailbox` connects Muse to the owner's agent-mailbox relay at the host in `config.json`. The owner's gateway leaves messages there; Muse reads them and posts replies back.
- Helper: `~/workspace/custom-connectors/custom.agent-mailbox/bin/mailbox.py`, commands `ping`, `inbox`, `progress`, `final`, `message`, `reply`. `~/mbx` is the same script under a short name.
- The hook `~/hooks/scripts/agent-mailbox.sh` runs every 5 seconds, polls `inbox` as often as the relay's `poll_after` says (5 s while in use, 30 s after an idle hour), and wakes an agent only when messages arrive. Do not run a second poller: `inbox --after` confirms and deletes messages.

## Connect

- Registered with `credentials.request_api_access`. Reuse the same details to reconnect. Header form:

```json
{
  "provider": "agent-mailbox",
  "auth_scheme": "api_key",
  "placement": "Authorization: Bearer {}",
  "api_hosts": ["mailbox.example.com"]
}
```

- Path form, if the header form cannot be registered: `"placement": "url_path_segment:/agent{}"`, then set `"placement": "path"` in `config.json`.
- The header `placement` string above is a guess at the setup flow's spelling; use whatever it calls an `Authorization: Bearer` header. The path form has the shape the Telegram bridge verified (`/bot{}`).
- `config.json` beside `bin/`: `{"base_url": "https://mailbox.example.com", "placement": "bearer"}` (or `"path"`). It must match the registration.
- Before the first change in a conversation, prove access:

```text
python3 ~/workspace/custom-connectors/custom.agent-mailbox/bin/mailbox.py ping
```

It prints `{"ok": true, "mailbox": "<id>", "role": "agent", "pending": <n>}`.

## Credentials

- The registered connection holds the token. The helper imports `/opt/muse/skills/custom-connector-setup/bin/dynamic_credentials.py`, which returns an `hsurr:` surrogate; Muse swaps in the real token only on an approved request to a registered host.
- The helper places the surrogate as-is. Do not build the URL with `url_with_surrogate_path_segment`: it percent-encodes the surrogate's colon and the swap no longer matches.
- Never put the token in this doc, the helper, a command argument, an environment variable or a log. Never ask the owner to paste it in chat.
- Redirects stay disabled.
- On 401: check that `config.json` placement matches the registration and the host is registered. Only if a request that carried the credential is still rejected, call `credentials.request_api_access` again with `"reconnect": true`.

## Read messages

```text
python3 ~/workspace/custom-connectors/custom.agent-mailbox/bin/mailbox.py inbox --after <cursor>
```

- Output: `{"ok": true, "messages": [{"seq", "session", "turn", "type", "text", "at"}], "cursor": <n>, "poll_after": <seconds>}`. `type` is `message` or `cancel`; `poll_after` is when the hook polls next.
- `--after` confirms everything up to that cursor; the relay deletes it. The hook owns the cursor; normally only the hook calls `inbox`.

## Reply

```text
~/mbx progress "<short status>"
~/mbx final <<'EOF'
<the answer>
EOF
~/mbx message --session <session> "<important result>"
```

- `progress`: what is being done now. Shown as a status line, not part of the answer.
- `final`: the answer; ends the turn. Long text is split automatically (earlier parts go as `message` of the same turn, the last as `final`).
- `message`: text outside a turn, for that session. It shows up as a separate update.
- The text is the argument, or stdin when there is none.
- No ids needed: `inbox` notes each turn it hands over in `~/.agent-mailbox/turns.json` and a `final` closes it. With one turn open, `progress` and `final` go to it. With several, they refuse and list them: add the `--session` and `--turn` given. A turn idle for 15 minutes is forgotten.
- Output: `{"ok": true, "seqs": [...], "session": "...", "turn": "..."}`. A 404 means the session is unknown or expired.
- Long form, ids explicit: `mailbox.py reply --session <s> --turn <t> --type progress|final|message (--text T | --text-file F | --text -)`.

## Limits

- 16000 characters per stored text (the helper splits finals and messages; progress is cut to 2000).
- Undelivered messages and unread replies expire after 7 days by default.
- One relay token per Muse account. Another agent must get its own mailbox.

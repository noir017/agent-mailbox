# Set up agent-mailbox

For Muse to follow. The owner's gateway leaves messages in an agent-mailbox relay; a hook in your VM
polls it and wakes you; you answer with a helper script. The owner tells you the relay URL.

The token: the owner enters it only in your secure credential form. Never ask for it in chat, never
write it into a file, command, environment variable or log.

Needs `python3` and `jq`. If either is missing, stop and tell the owner.

## 1. Files

Download each from `https://raw.githubusercontent.com/noir017/agent-mailbox/main/integrations/muse/`
and save it. Overwrite files from an earlier setup.

| Under that URL | Save as | Mode |
|---|---|---|
| `connector/custom.agent-mailbox/CONNECTOR.md` | `~/workspace/custom-connectors/custom.agent-mailbox/CONNECTOR.md` | 644 |
| `connector/custom.agent-mailbox/connector.yaml` | `~/workspace/custom-connectors/custom.agent-mailbox/connector.yaml` | 644 |
| `connector/custom.agent-mailbox/bin/mailbox.py` | `~/workspace/custom-connectors/custom.agent-mailbox/bin/mailbox.py` | 755 |
| `connector/custom.agent-mailbox/bin/mbx` | `~/workspace/custom-connectors/custom.agent-mailbox/bin/mbx` | 755 |
| `hooks/agent-mailbox.sh` | `~/hooks/scripts/agent-mailbox.sh` | 755 |
| `hooks/agent-mailbox.json` | where your runtime keeps hook definitions | 644 |

Link the short name you will answer with:

```text
ln -sf ~/workspace/custom-connectors/custom.agent-mailbox/bin/mbx ~/mbx
```

Write `~/workspace/custom-connectors/custom.agent-mailbox/config.json`, with the relay URL the owner
gave (scheme and host only, no path):

```json
{"base_url": "https://<relay host>", "placement": "bearer"}
```

## 2. Credential

With your `custom-connector-setup` skill, register the connection with
`credentials.request_api_access`:

```json
{
  "provider": "agent-mailbox",
  "auth_scheme": "api_key",
  "placement": "<an Authorization: Bearer header, as your setup flow spells it>",
  "api_hosts": ["<relay host>"]
}
```

The connector id is `custom.agent-mailbox`. The owner pastes the agent token into the form that
opens.

## 3. Check

```text
python3 ~/workspace/custom-connectors/custom.agent-mailbox/bin/mailbox.py ping
```

Expect `{"ok": true, "mailbox": "<id>", "role": "agent", ...}`. The first request may need the owner
to approve outbound access to the relay host.

| Result | Do |
|---|---|
| header placement refused, or `HTTP 401` | register again with `"placement": "url_path_segment:/agent{}"` and `"reconnect": true`; set `"placement": "path"` in `config.json`; ping again |
| `HTTP 404` | `base_url` is wrong: scheme and host only |
| `redirect refused` | `base_url` must start with `https://` |
| `cannot reach the relay` | DNS, or outbound access not approved yet |

Still 401 with the path form: stop and tell the owner; the token may be wrong.

## 4. Hook

Register `agent-mailbox.json` as a hook and enable it. It runs `~/hooks/scripts/agent-mailbox.sh`
every 5 seconds; the script asks the relay only when due and wakes you only when a message is
waiting. The rules for handling messages are in the hook's `prompt`: you answer with `~/mbx`, and
what you write in the conversation itself is not delivered.

Do not call `inbox` yourself: the hook owns the cursor, and `inbox` confirms and deletes messages.

## 5. Report

Tell the owner: the mailbox id from `ping`, which placement worked, and that the hook is on. Ask
them to send a test message from the gateway. The first one may take up to 30 seconds to be picked
up; answer it by the hook's rules (`~/mbx final`).

## Update

When the owner asks you to update: do step 1 again (download every file in the table, overwrite,
keep `config.json`, make the `~/mbx` link), then register `agent-mailbox.json` again so the hook
takes its new `prompt`. The credential and the hook's state stay as they are. Run `ping`, and tell
the owner it is done.

An older version kept per-session files in `~/workspace/agent-mailbox/`; nothing uses them now, so
that folder can be deleted.

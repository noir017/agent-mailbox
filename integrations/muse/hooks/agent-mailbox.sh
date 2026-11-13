#!/usr/bin/env bash
# agent-mailbox hook: poll the relay's inbox, wake the agent only when something arrived.
# Install as ~/hooks/scripts/agent-mailbox.sh (see integrations/muse/README.md).
# Adapted from telegram-muse-bridge's hook (MIT, see NOTICE).
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

HELPER="$HOME/workspace/custom-connectors/custom.agent-mailbox/bin/mailbox.py"

state="$(hook_state_get)"
[[ -n "$state" ]] || state='{}'
cursor="$(printf '%s' "$state" | jq -r '.cursor // empty')"

args=(inbox)
if [[ -n "$cursor" ]]; then
  args+=(--after "$cursor")
fi

# Short poll: the relay answers at once. A held long poll would keep the relay's Durable Object
# billed for the whole wait (relay README, "Free plan").
if ! raw="$(python3 "$HELPER" "${args[@]}" 2>/dev/null)"; then
  log "fetch_failed" '{}'
  silent "mailbox fetch failed"
  exit 0
fi

count="$(printf '%s' "$raw" | jq -r '.messages | length' 2>/dev/null || printf '0')"
if [[ "$count" == "0" ]]; then
  silent "no new mailbox messages"
  exit 0
fi

# Save the cursor before waking: the next poll sends it back, which confirms these messages and
# lets the relay delete them. Same order as the Telegram bridge's offset.
new_cursor="$(printf '%s' "$raw" | jq -r '.cursor')"
hook_state_set "$(printf '%s' "$state" | jq -c --argjson c "$new_cursor" '.cursor = $c')"

payload="$(printf '%s' "$raw" | jq -c '{messages: [.messages[] | {seq, session, turn, type, text}]}')"
log "messages_received" "$(jq -cn --argjson n "$count" '{count: $n}')"
wake "mailbox messages received" "$payload"
exit 0

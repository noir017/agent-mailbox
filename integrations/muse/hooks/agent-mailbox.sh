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
now="$(date +%s)"

# The hook runs every 5 s, but the relay decides how often it is actually asked: every 5 s while
# messages are going back and forth, every 30 s after an hour without any (its `poll_after`).
# Requests per day are what the relay's free plan runs out of. A tick before `next_at` sends nothing.
next_at="$(printf '%s' "$state" | jq -r '.next_at // 0')"
if [[ "$next_at" =~ ^[0-9]+$ ]] && (( now < next_at )); then
  silent "not due"
  exit 0
fi

args=(inbox)
if [[ -n "$cursor" ]]; then
  args+=(--after "$cursor")
fi

# Short poll: the relay answers at once. A held long poll would keep the relay's Durable Object
# billed for the whole wait (relay README, "Free plan").
if ! raw="$(python3 "$HELPER" "${args[@]}" 2>/dev/null)"; then
  # next_at is left as it was, so the next tick tries again.
  log "fetch_failed" '{}'
  silent "mailbox fetch failed"
  exit 0
fi

# Bounded, so a broken or older relay can neither stop the polling nor make it hammer: missing
# means the hook's own interval. One second off so a 5 s hook tick does not slip a whole tick late.
after="$(printf '%s' "$raw" | jq -r '(.poll_after // 5) | if type == "number" then . else 5 end | floor | if . < 1 then 1 elif . > 300 then 300 else . end')"
next=$(( now + after - 1 ))

count="$(printf '%s' "$raw" | jq -r '.messages | length' 2>/dev/null || printf '0')"
if [[ "$count" == "0" ]]; then
  hook_state_set "$(printf '%s' "$state" | jq -c --argjson n "$next" '.next_at = $n')"
  silent "no new mailbox messages"
  exit 0
fi

# Save the cursor before waking: the next poll sends it back, which confirms these messages and
# lets the relay delete them. Same order as the Telegram bridge's offset.
new_cursor="$(printf '%s' "$raw" | jq -r '.cursor')"
hook_state_set "$(printf '%s' "$state" | jq -c --argjson c "$new_cursor" --argjson n "$next" '.cursor = $c | .next_at = $n')"

payload="$(printf '%s' "$raw" | jq -c '{messages: [.messages[] | {seq, session, turn, type, text}]}')"
log "messages_received" "$(jq -cn --argjson n "$count" '{count: $n}')"
wake "mailbox messages received" "$payload"
exit 0

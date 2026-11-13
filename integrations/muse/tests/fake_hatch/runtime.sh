# Fake Hatch hook runtime, for running the real hook script outside Muse.
# Sourced through $HATCH_HOOK_RUNTIME, like the real one. Everything lands in $FAKE_HATCH_DIR:
#   state.json   hook state (hook_state_get / hook_state_set)
#   result.json  the outcome: {"action": "silent"|"wake", "reason", "payload"?}
#   log.jsonl    log events
# silent and wake end the script: the real hook relies on that (it continues after a silent in an
# if-branch only because silent does not return), and so does this fake.
: "${FAKE_HATCH_DIR:?FAKE_HATCH_DIR must be set}"

hook_state_get() {
  if [[ -f "$FAKE_HATCH_DIR/state.json" ]]; then cat "$FAKE_HATCH_DIR/state.json"; else printf '{}'; fi
}

hook_state_set() {
  printf '%s' "$1" | jq -e . >/dev/null || { echo "hook_state_set: not JSON" >&2; exit 97; }
  printf '%s' "$1" > "$FAKE_HATCH_DIR/state.json.tmp"
  mv "$FAKE_HATCH_DIR/state.json.tmp" "$FAKE_HATCH_DIR/state.json"
}

log() {
  jq -cn --arg event "$1" --argjson data "${2:-{\}}" '{event: $event, data: $data}' >> "$FAKE_HATCH_DIR/log.jsonl"
}

_fake_hatch_result() {
  if [[ -f "$FAKE_HATCH_DIR/result.json" ]]; then echo "hook decided twice" >&2; exit 98; fi
  printf '%s\n' "$1" > "$FAKE_HATCH_DIR/result.json"
}

silent() {
  _fake_hatch_result "$(jq -cn --arg reason "$1" '{action: "silent", reason: $reason}')"
  exit 0
}

wake() {
  local payload
  payload="$(printf '%s' "${2:-null}" | jq -c .)" || { echo "wake: payload is not JSON" >&2; exit 99; }
  _fake_hatch_result "$(jq -cn --arg reason "$1" --argjson payload "$payload" '{action: "wake", reason: $reason, payload: $payload}')"
  exit 0
}

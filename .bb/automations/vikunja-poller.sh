#!/bin/bash
# Vikunja -> BB Task Router poller.
# Polls Vikunja for tasks updated since the last tick and wakes the router
# thread with the changed list. Prints {"wakeAgent": false} on silent ticks
# (nothing changed), so the run is recorded as skipped.
set -euo pipefail

ROUTER_THREAD="thr_vt8h6pqjsc"
STATE_FILE="vikunja-poller-state.json"
BB_BIN="${BB_CLI:-bb}"

ts_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# First ever run: initialize state with a backfill watermark and stay silent.
# Edit the watermark in the state file to backfill older tasks.
if [[ ! -f "$STATE_FILE" ]]; then
  printf '{"watermark":"%s"}\n' "$(ts_now)" > "$STATE_FILE"
  echo '{"wakeAgent": false}'
  exit 0
fi

watermark=$(jq -r '.watermark' "$STATE_FILE")

resp=$("$BB_BIN" vikunja call tasks_list "$(jq -nc --arg wm "$watermark" \
  '{filter: ("updated > \"" + $wm + "\""), sort_by: ["updated"], order_by: ["desc"], page: 1, per_page: 50}')" --json)

changed=$(printf '%s' "$resp" | jq -c \
  '[.items[] | {id, identifier, title, project_id, done, updated, due_date, priority}]')

count=$(printf '%s' "$changed" | jq 'length')
if [[ "$count" -eq 0 ]]; then
  echo '{"wakeAgent": false}'
  exit 0
fi

# Skip tasks whose (id, updated) pair was already delivered in an earlier tick.
fresh=$(printf '%s' "$changed" | jq --argjson state "$(cat "$STATE_FILE")" \
  '[.[] | select((($state.seen // {})[(.id | tostring)] // "") != .updated)]')
fresh_count=$(printf '%s' "$fresh" | jq 'length')
if [[ "$fresh_count" -eq 0 ]]; then
  echo '{"wakeAgent": false}'
  exit 0
fi

message=$(printf '%s' "$fresh" | jq -r --arg wm "$watermark" \
  '"Vikunja changes since " + $wm + ":\n" +
   ([.[] | "- #\(.id) \(.identifier) [project \(.project_id)] \(.title) (updated \(.updated), done \(.done))"] | join("\n")) +
   "\nRoute these per standing instructions."')

# If this fails, the script exits non-zero BEFORE the state advances, so the
# next tick redelivers; the router is idempotent (it checks task links first).
printf '%s' "$message" | "$BB_BIN" thread tell "$ROUTER_THREAD" --message-file -

max_updated=$(printf '%s' "$changed" | jq -r '[.[].updated] | max')
printf '%s' "$changed" | jq --arg w "$max_updated" \
  '{watermark: $w, seen: (map({key: (.id | tostring), value: .updated}) | from_entries)}' > "$STATE_FILE"

echo "Woke router $ROUTER_THREAD for $fresh_count changed Vikunja task(s)."

#!/bin/bash
# Vikunja -> BB Task Router reconciler.
# Hourly sweep: finds not-done Vikunja tasks with no BB thread link (missed by
# the poller or left unrouted by a failed spawn) and wakes the router.
# Prints {"wakeAgent": false} when every open task is routed.
set -euo pipefail

ROUTER_THREAD="thr_vt8h6pqjsc"
BB_BIN="${BB_CLI:-bb}"

resp=$("$BB_BIN" vikunja call tasks_list \
  '{"filter":"done = false","sort_by":["updated"],"order_by":["desc"],"page":1,"per_page":100}' --json)

ids=$(printf '%s' "$resp" | jq -r '.items[] | .id')
if [[ -z "$ids" ]]; then
  echo '{"wakeAgent": false}'
  exit 0
fi

unrouted_json="["
first=1
for id in $ids; do
  links=$("$BB_BIN" vikunja links "$id" --json)
  if [[ "$links" == "[]" ]]; then
    [[ $first -eq 1 ]] || unrouted_json+=","
    unrouted_json+="$id"
    first=0
  fi
done
unrouted_json+="]"

if [[ $first -eq 1 ]]; then
  echo '{"wakeAgent": false}'
  exit 0
fi

message=$(printf '%s' "$resp" | jq -r --argjson unrouted "$unrouted_json" '
  ([.items[] | select(.id as $i | $unrouted | index($i))]) as $u |
  "Vikunja changes since " + ($u | map(.updated) | min) + " (reconciliation):\n" +
  ($u | map("- #\(.id) \(.identifier) [project \(.project_id)] \(.title) (updated \(.updated), done \(.done))") | join("\n")) +
  "\nRoute these per standing instructions."')

printf '%s' "$message" | "$BB_BIN" thread tell "$ROUTER_THREAD" --message-file -
echo "Woke router: unrouted Vikunja task(s) $unrouted_json"

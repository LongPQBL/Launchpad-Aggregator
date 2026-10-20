#!/usr/bin/env bash
# Keeps an Envio window moving on a HyperSync token with a points budget (for example 15,000 points a minute, 1,000 per query).
#   scripts/window-envio-watchdog.sh LABEL
# Envio splits its fetching into one query per partition and a window grows to dozens of partitions. When they all retry at the same
# moment the budget never has room, and the indexer makes no progress at all (measured: 0 finished queries in 30 minutes, with the budget
# full again 52 seconds after the indexer was stopped). The cure is to stop the indexer for longer than the budget window and start it again:
# it resumes from its checkpoint, begins with few partitions and runs fast until they multiply. This only restarts the container; it never
# touches the data. A token without a budget makes it a no-op, because the indexer never stalls.
# Env: WATCHDOG_STALL_SECONDS (no finished batch for this long counts as stalled, default 90), WATCHDOG_PAUSE_SECONDS (default 62).
label="${1:-}"
[[ "$label" =~ ^[a-z0-9_]+$ ]] || { echo "usage: scripts/window-envio-watchdog.sh LABEL" >&2; exit 2; }
container="envio-indexer-${label}"
stall="${WATCHDOG_STALL_SECONDS:-90}"; pause="${WATCHDOG_PAUSE_SECONDS:-62}"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
batches_since() { docker logs "$container" --since "${1}s" 2>&1 | grep -c "Finished processing"; }
say "watching $container (stalled after ${stall}s without a finished batch, pause ${pause}s)"
sleep "$stall"
while true; do
  state="$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || echo missing)"
  if [ "$state" = "false" ]; then say "$container is stopped, starting it"; docker start "$container" >/dev/null; sleep "$stall"; continue; fi
  if [ "$state" = "true" ] && [ "$(batches_since "$stall")" -eq 0 ]; then
    say "no finished batch for ${stall}s: stopping for ${pause}s so the HyperSync budget can refill"
    docker stop "$container" >/dev/null; sleep "$pause"; docker start "$container" >/dev/null; say "started again"
    sleep "$stall"; continue
  fi
  sleep 30
done

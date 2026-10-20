#!/usr/bin/env bash
# Runs once, when a window's sync is within LAG blocks of the chain head: builds the candle cache the API reads, rebuilds the volume buckets that were built before their oracle
# rounds existed (otherwise the 1D candle stays hidden) and sets the *_done flags (without pool_volume_done every pool volume is null).
# Started by window-up.sh with the window's environment already exported.
set -uo pipefail
label="$1"; lag="${2:-2000}"
root="$(cd "$(dirname "$0")/.." && pwd)"
state="$root/.superpowers/window/$label"
marker="$state/after-catchup.done"
[ -f "$marker" ] && exit 0
cd "$root"
[ -n "${RH_HTTP_RPC_URL:-}" ] || RH_HTTP_RPC_URL="$(grep -E '^RH_HTTP_RPC_URL=' be/.env | head -1 | cut -d= -f2-)"

head_block() {
  curl -s -m 10 -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$RH_HTTP_RPC_URL" \
    | python3 -c "import sys,json;print(int(json.load(sys.stdin)['result'],16))" 2>/dev/null
}
app_container="$(docker ps --format '{{.Names}}' | grep -E 'launchpad-aggregator-postgres' | head -1)"
db="${DATABASE_URL##*/}"

# The slowest official-trade stream, either lane, decides: a stream that is behind still has trades to write.
while true; do
  head="$(head_block || true)"
  slowest="$(docker exec "$app_container" psql -U launchpad -d "$db" -At -c \
    "SELECT min(processed_watermark) FROM envio_sync_cursors WHERE stream IN ('v2-launch','v2-curve','v4-swap')" 2>/dev/null || true)"
  if [ -n "$head" ] && [ -n "$slowest" ] && [ $((head - slowest)) -le "$lag" ]; then break; fi
  sleep 30
done
echo "$(date -u +%FT%TZ) sync is within $lag blocks of the head; rebuilding volume buckets"
# Without it the API rereads every trade of the last 52 weeks of a launch each time it computes its stats (candle_cache_state never becomes ready).
npm run -w be candles:backfill
npm run -w be charts:backfill-volume -- --unpriced --concurrency 8
npm run -w be charts:backfill-volume
date -u +%FT%TZ > "$marker"
echo "$(date -u +%FT%TZ) done"

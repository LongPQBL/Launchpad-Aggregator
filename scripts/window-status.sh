#!/usr/bin/env bash
# Read-only status of one indexing window started by scripts/window-up.sh. Never prints RPC urls or tokens.
#   scripts/window-status.sh LABEL
# Shows: chain head, Envio progress and its HyperSync errors, sync cursors and row counts, worker liveness, fast lane state, API latency.
set -uo pipefail
label="${1:-}"
[[ "$label" =~ ^[a-z0-9_]+$ ]] || { echo "usage: scripts/window-status.sh LABEL" >&2; exit 2; }
root="$(cd "$(dirname "$0")/.." && pwd)"
state="$root/.superpowers/window/$label"; logs="$state/logs"
[ -f "$state/env" ] || { echo "no window '$label' (missing $state/env)" >&2; exit 1; }
env_value() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2-; }
container="envio-indexer-${label}"
metrics_url="$(env_value "$state/env" ENVIO_METRICS_URL)"; api_port="$(env_value "$state/env" API_PORT)"
app_container="${APP_PG_CONTAINER:-$(docker ps --filter publish=55432 --format '{{.Names}}' | head -1)}"
psql_app() { docker exec "$app_container" psql -U launchpad -d "launchpad_${label}" -At -c "$1" 2>&1; }

date +%H:%M
rpc_url="$(env_value "$root/be/.env" RH_HTTP_RPC_URL)"
reply="$(curl -s -m 10 -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$rpc_url")"
head="$(echo "$reply" | python3 -c "import sys,json;print(int(json.load(sys.stdin)['result'],16))" 2>/dev/null)"
echo "rpc: ${head:-ERROR $(echo "$reply" | cut -c1-60)}"

metrics="$(curl -s -m 30 "$metrics_url")"
progress="$(echo "$metrics" | grep -E '^envio_progress_block\{' | awk '{print $2}')"
if [ -z "$progress" ]; then   # the metrics page times out while Envio is busy: read the last batch from its log instead
  progress="$(docker logs "$container" --since 3m 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g' | grep -E '^\s+progress:' | tail -1 | grep -oE '[0-9]+')"
fi
echo "envio: progress=${progress:-n/a} head=${head:-n/a} remaining=$(( ${head:-0} - ${progress:-0} )) partitions=$(echo "$metrics" | grep -E '^envio_indexing_partitions' | awk '{print $2}') addresses=$(echo "$metrics" | grep -E '^envio_indexing_addresses' | awk '{print $2}')"
recent="$(docker logs "$container" --since 10m 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g')"
echo "envio last 10m: revoked/403=$(echo "$recent" | grep -cE 'revoked|403 Forbidden') 401=$(echo "$recent" | grep -c '401 Unauthorized') 429=$(echo "$recent" | grep -c '429') rate-limited=$(echo "$recent" | grep -c 'rate-limited') finished_batches=$(echo "$recent" | grep -c 'Finished processing')"

psql_app "select 'launches',count(*) from launches union all select 'named',count(*) from launches where name is not null and symbol is not null union all select 'pools',count(*) from pool_catalog union all select 'trades',count(*) from trades union all select 'pool_trades',count(*) from pool_trades" | tr '\n' ' '; echo
psql_app "select 'cursor wm min/max', min(coalesce(processed_watermark,block_number)), max(coalesce(processed_watermark,block_number)) from envio_sync_cursors"
psql_app "select 'curve trades unpriced',count(*) from trades t join venues v on v.id=t.venue_id where v.kind='curve' and v.official and t.price_numerator_raw is null; select 'launches w/o stats',count(*) from launches l where not exists (select 1 from launch_stats s where s.chain_id=l.chain_id and s.token_address=l.token_address); select 'lane state',coalesce(string_agg(chain_id||':'||coverage_block::text,','),'none') from fast_lane_state" | tr '\n' ' '; echo
echo "procs: cli=$(ps aux | grep '[s]rc/cli' | grep -o 'src/cli/[A-Za-z]*' | sort -u | wc -l) next=$(ps aux | grep -c '[n]ext-server')"
for f in "$logs"/*.log; do n="$(basename "$f" .log)"; echo -n "$n(rpc-disabled=$(grep -c 'api client is disabled' "$f" 2>/dev/null)) "; done; echo
grep -v '^ *$' "$logs/fast-lane.log" 2>/dev/null | tail -1 | cut -c1-170
t() { curl -s -o /dev/null -m 60 -w "$1 %{http_code} %{time_total}s\n" "http://127.0.0.1:${api_port}$2"; }
t launches "/v1/launches?chainId=4663&limit=20"; t transactions "/v1/transactions?limit=20"; t pools "/v1/pools?chainId=4663&limit=20"

#!/usr/bin/env bash
# Brings up one indexing window end to end: Envio from START_BLOCK, a fresh app database, and every worker pointed at them.
#   scripts/window-up.sh START_BLOCK [LABEL]
# Everything it creates is named after LABEL (default w<START_BLOCK>), so two windows never share a database, container, volume or log:
#   app DB launchpad_<label>, Envio DB envio_<label>, docker project envio-<label>, logs/pids under .superpowers/window/<label>/.
# Ports default to the values the stack already uses; override them (PG_PORT, HASURA_PORT, METRICS_PORT, API_PORT, FE_PORT) to run a second
# window next to the first. It refuses to start if a port, a database or a window of that label is already in use.
# Options (env): WITH_FE=0 (skip Next.js), ENVIO_WATCHDOG=0 (do not restart a stalled Envio), REBUILD_ENVIO=0 (reuse the image), AFTER_CATCHUP_LAG=2000 (blocks behind head that count as caught up).
# Stop with scripts/window-down.sh LABEL [--purge].
set -euo pipefail
trap 'echo "window-up failed at line $LINENO; nothing is left running except what was started so far: scripts/window-down.sh ${label:-LABEL} --purge cleans it up" >&2' ERR

start_block="${1:-}"
[[ "$start_block" =~ ^[0-9]+$ ]] || { echo "usage: scripts/window-up.sh START_BLOCK [LABEL]" >&2; exit 2; }
label="${2:-w${start_block}}"
[[ "$label" =~ ^[a-z0-9_]+$ ]] || { echo "LABEL may only contain a-z, 0-9 and _" >&2; exit 2; }

root="$(cd "$(dirname "$0")/.." && pwd)"
state="$root/.superpowers/window/$label"
logs="$state/logs"
pg_port="${PG_PORT:-5435}"; hasura_port="${HASURA_PORT:-8082}"; metrics_port="${METRICS_PORT:-19899}"
api_port="${API_PORT:-3001}"; fe_port="${FE_PORT:-3000}"
catchup_lag="${AFTER_CATCHUP_LAG:-2000}"
with_fe="${WITH_FE:-1}"; rebuild="${REBUILD_ENVIO:-1}"
app_db="launchpad_${label}"; envio_db="envio_${label}"; project="envio-${label}"
compose=(docker compose -p "$project" -f "$root/envio/docker-compose.yaml" -f "$root/envio/window-${label}.compose.yaml")

die() { echo "window-up: $*" >&2; exit 1; }
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
env_value() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2-; }
psql_app() { docker exec "$app_container" psql -U launchpad -d "$1" -At -c "$2"; }

# ---- preflight: everything that would make the bring-up fail halfway is checked before anything is created -------------------------------
[ -f "$state/pids" ] && die "window '$label' is already running (see $state/pids); run scripts/window-down.sh $label first"
docker info >/dev/null 2>&1 || die "docker is not running"
[ -f "$root/envio/.env" ] && [ -f "$root/be/.env" ] || die "envio/.env and be/.env are required"
[ -n "$(env_value "$root/envio/.env" ENVIO_API_TOKEN)" ] || die "ENVIO_API_TOKEN is empty in envio/.env"
[ -n "$(env_value "$root/be/.env" RH_HTTP_RPC_URL)" ] || die "RH_HTTP_RPC_URL is empty in be/.env"
for pair in "PG_PORT:$pg_port" "HASURA_PORT:$hasura_port" "METRICS_PORT:$metrics_port" "API_PORT:$api_port"; do
  port_busy "${pair#*:}" && die "port ${pair#*:} (${pair%%:*}) is already in use; pick another with ${pair%%:*}=..."
done
[ "$with_fe" = "1" ] && port_busy "$fe_port" && die "port $fe_port (FE_PORT) is already in use; set WITH_FE=0 or FE_PORT=..."
app_container="$(docker ps --format '{{.Names}}' | grep -E 'launchpad-aggregator-postgres' | head -1 || true)"
[ -n "$app_container" ] || die "the app Postgres container (launchpad-aggregator-postgres-*) is not running"
[ -z "$(psql_app postgres "SELECT 1 FROM pg_database WHERE datname='$app_db'")" ] || die "database $app_db already exists; pick another LABEL or drop it"
docker ps -a --format '{{.Names}}' | grep -qx "envio-indexer-${label}" && die "container envio-indexer-${label} already exists"

# Two Envio stacks (each: a Postgres tuned with 1 GB of shared buffers, Hasura, an indexer allowed 2.5 GB) do not fit in a small Docker VM; both
# crawl and Hasura's health check times out. Refuse by default, with the way out spelled out.
docker_mem_gb=$(( $(docker info --format '{{.MemTotal}}') / 1073741824 ))
running_indexers="$(docker ps --format '{{.Names}}' | grep -c '^envio-indexer' || true)"
if [ "$running_indexers" -ge 1 ] && [ "$docker_mem_gb" -lt 8 ] && [ "${FORCE:-0}" != "1" ]; then
  die "another Envio indexer is running and Docker has only ${docker_mem_gb} GB: stop it first (scripts/window-down.sh LABEL), give Docker 8 GB or more, or set FORCE=1"
fi

mkdir -p "$logs"

# ---- Envio ------------------------------------------------------------------------------------------------------------------------------
sed -e "s/__NAME__/pons-envio-indexer-${label}/" -e "s/__START_BLOCK__/${start_block}/g" "$root/envio/config.window.template.yaml" \
  > "$root/envio/window-${label}.config.yaml"
cat > "$root/envio/window-${label}.compose.yaml" <<EOF
services:
  envio-postgres:
    ports: !override
      - "${pg_port}:5432"
  graphql-engine:
    ports: !override
      - "${hasura_port}:8080"
  envio-indexer:
    image: envio-envio-indexer:window
    container_name: envio-indexer-${label}
    ports: !override
      - "127.0.0.1:${metrics_port}:9898"
    volumes:
      - ./window-${label}.config.yaml:/envio-indexer/window-${label}.config.yaml:ro
EOF
export CONFIG_FILE="window-${label}.config.yaml" ENVIO_PG_DATABASE="$envio_db" ENVIO_PG_PORT="$pg_port"
[ "$rebuild" = "1" ] && "${compose[@]}" build envio-indexer
# Hasura can need longer than compose waits for on a busy machine ("dependency failed to start: unhealthy"): ask again, it keeps what is up.
for attempt in 1 2 3; do "${compose[@]}" up -d && break; [ "$attempt" = 3 ] && die "docker compose could not start the Envio stack"; sleep 15; done
echo "waiting for Envio's database..."
envio_pg_pass="$(env_value "$root/envio/.env" ENVIO_PG_PASSWORD || true)"; envio_pg_pass="${envio_pg_pass:-testing}"
for _ in $(seq 1 60); do docker exec "${project}-envio-postgres-1" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done
docker exec "${project}-envio-postgres-1" pg_isready -U postgres >/dev/null 2>&1 || die "Envio's database did not become ready"

# ---- app database + environment shared by every process --------------------------------------------------------------------------------
psql_app postgres "CREATE DATABASE $app_db" >/dev/null
app_url="$(env_value "$root/be/.env" DATABASE_URL)"; app_url="${app_url%/*}/${app_db}"
cat > "$state/env" <<EOF
DATABASE_URL=$app_url
ENVIO_DATABASE_URL=postgres://postgres:${envio_pg_pass}@127.0.0.1:${pg_port}/${envio_db}
ENVIO_INDEXED_FROM_BLOCK=${start_block}
ENVIO_METRICS_URL=http://127.0.0.1:${metrics_port}/metrics
API_PORT=${api_port}
FE_ORIGIN=http://localhost:${fe_port}
FAST_LANE_MODE=after-catchup
ENVIO_METADATA_BATCH_LIMIT=50
METADATA_ENRICHMENT_TICK_MS=5000
METADATA_ENRICHMENT_PASS_INTERVAL_MS=5000
EOF
E=(env $(grep -v '^#' "$state/env" | xargs))
cd "$root"
"${E[@]}" npm run -w be db:migrate >"$logs/migrate.log" 2>&1 || die "migration failed, see $logs/migrate.log"
"${E[@]}" npm run -w be seed:known-quote-feeds >"$logs/seed.log" 2>&1 || die "seeding quote feeds failed, see $logs/seed.log"

# ---- processes: one pid per line in $state/pids so window-down stops exactly these ------------------------------------------------------
: > "$state/pids"
start() { local name="$1"; shift; nohup "$@" >"$logs/$name.log" 2>&1 & echo "$! $name" >> "$state/pids"; }
# Metadata (name, symbol, decimals) gates curve pricing, stats and a launch showing in the list; the defaults (10 launches a minute) cannot keep up
# with a backfill. The pass interval is a separate minimum spacing enforced when claiming, so the tick alone would not speed anything up.
# Order matters a little: the sync loop creates the static sources the other workers' foreign keys point at.
start sync "${E[@]}" npm run -w be sync:envio-staging:loop
sleep 5
start api "${E[@]}" npm run -w be dev:api
start prices "${E[@]}" npm run -w be prices:worker
start candles "${E[@]}" npm run -w be candles:worker
start pool-candles "${E[@]}" npm run -w be pools:candles:worker
start launch-volume "${E[@]}" npm run -w be launch-volume:worker
start curve-pricing "${E[@]}" npm run -w be curve-pricing:worker
start launch-stats "${E[@]}" npm run -w be launch-stats:worker
start tvl "${E[@]}" npm run -w be pools:tvl-snapshots:worker
start fast-lane "${E[@]}" npm run -w be fast-lane:run
# The oracle history only fetches feeds that already have a trade in the database, so it has to keep looping while the sync fills it.
start oracle-history "${E[@]}" bash -c 'while true; do npm run -w be prices:backfill-history -- --concurrency 8 || true; sleep 90; done'
if [ "$with_fe" = "1" ]; then
  start fe "${E[@]}" NEXT_PUBLIC_BE_API_URL="http://127.0.0.1:${api_port}" BE_API_URL="http://127.0.0.1:${api_port}" npm run -w fe dev -- --port "$fe_port"
fi

# Restarts a stalled Envio (a HyperSync token with a points budget starves when many partitions retry at once); a no-op on an unmetered token.
[ "${ENVIO_WATCHDOG:-1}" = "1" ] && start envio-watchdog bash "$root/scripts/window-envio-watchdog.sh" "$label"

# ---- after catch-up: rebuilds the volume buckets that were built before their oracle rounds existed, once -------------------------------------
start after-catchup "${E[@]}" bash "$root/scripts/window-after-catchup.sh" "$label" "$catchup_lag"

cat <<EOF

Window '$label' is starting from block $start_block.
  app DB $app_db | Envio DB $envio_db (port $pg_port) | Envio metrics http://127.0.0.1:${metrics_port}/metrics
  API http://127.0.0.1:${api_port}$([ "$with_fe" = "1" ] && echo " | app http://localhost:${fe_port}")
  logs   $logs
  stop   scripts/window-down.sh $label [--purge]
EOF

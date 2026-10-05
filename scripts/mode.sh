#!/usr/bin/env bash
# Switch the local stack between test and production.
#   test: Envio indexes from a recent block (envio/config.test.yaml); the app writes to launchpad_staging.
#   prod: Envio indexes from the production start blocks (envio/config.yaml); the app writes to launchpad.
# Envio keeps one indexer state, so changing the config restarts it with --restart (clears its database).
set -euo pipefail

mode="${1:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
state_file="$root/.superpowers/mode/current"
log_dir="$root/.superpowers/mode/logs"
mkdir -p "$(dirname "$state_file")" "$log_dir"

case "$mode" in
  test) envio_config="config.test.yaml" ;;
  prod) envio_config="config.yaml" ;;
  *) echo "usage: scripts/mode.sh test|prod" >&2; exit 2 ;;
esac

prod_url="$(grep '^DATABASE_URL=' "$root/be/.env" | head -1 | cut -d= -f2-)"
if [ "$mode" = "test" ]; then
  app_url="${prod_url%/launchpad}/launchpad_staging"
else
  app_url="$prod_url"
fi
previous="$(cat "$state_file" 2>/dev/null || echo none)"

pkill -9 -f "syncEnvioStagingLoop|runLaunchVolumeWorker|runUsdCandleWorker|runLaunchStatsWorker|cli/api.ts" 2>/dev/null || true
sleep 2

restart_envio=""
if [ "$previous" != "$mode" ]; then restart_envio="--restart"; fi
pkill -f "envio dev" 2>/dev/null || true
sleep 2
(cd "$root/envio" && ENVIO_CONFIG="$envio_config" nohup npx envio dev $restart_envio < /dev/null > "$log_dir/envio-$mode.log" 2>&1 &)

# The app's Envio reader expects tables under schema "envio"; envio dev writes them to "public".
# Wait for the indexer storage, then (re)create read-only views. --restart drops this schema, so do it every switch.
if [ -n "$restart_envio" ]; then
  for _ in $(seq 1 240); do
    if grep -q "Starting indexing" "$log_dir/envio-$mode.log" 2>/dev/null; then break; fi
    sleep 5
  done
else
  sleep 20
fi
views="CREATE SCHEMA IF NOT EXISTS envio;"
for t in $(docker exec envio-postgres psql -U postgres -d envio-dev -tAc "select table_name from information_schema.tables where table_schema = 'public' and (table_name like 'Raw%' or table_name = 'chain_metadata')"); do
  views="$views CREATE OR REPLACE VIEW envio.\"$t\" AS SELECT * FROM public.\"$t\";"
done
docker exec envio-postgres psql -U postgres -d envio-dev -c "$views" > /dev/null

cd "$root/be"
(DATABASE_URL="$app_url" nohup npm run dev:api < /dev/null > "$log_dir/api-$mode.log" 2>&1 &)
(STAGING_UPDATE_COVERAGE=$([ "$mode" = test ] && echo 1 || echo 0) DATABASE_URL="$app_url" nohup npm run sync:envio-staging:loop < /dev/null > "$log_dir/sync-$mode.log" 2>&1 &)
(DATABASE_URL="$app_url" nohup npm run launch-volume:worker < /dev/null > "$log_dir/worker-$mode.log" 2>&1 &)
(DATABASE_URL="$app_url" nohup npm run usd-candles:worker < /dev/null > "$log_dir/usd-candles-$mode.log" 2>&1 &)
(DATABASE_URL="$app_url" nohup npm run launch-stats:worker < /dev/null > "$log_dir/launch-stats-$mode.log" 2>&1 &)
(DATABASE_URL="$app_url" nohup npm run curve-pricing:worker < /dev/null > "$log_dir/curve-pricing-$mode.log" 2>&1 &)

echo "$mode" > "$state_file"
echo "mode=$mode envio_config=$envio_config envio_restart=${restart_envio:-no} app_db=${app_url##*/}"
echo "logs: $log_dir"

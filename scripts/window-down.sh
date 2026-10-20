#!/usr/bin/env bash
# Stops everything scripts/window-up.sh started for LABEL. With --purge it also removes the window's Envio stack and volume, its app
# database and its generated files (data is gone for good: the window would have to be indexed again).
#   scripts/window-down.sh LABEL [--purge]
set -uo pipefail
label="${1:-}"; purge="${2:-}"
[[ "$label" =~ ^[a-z0-9_]+$ ]] || { echo "usage: scripts/window-down.sh LABEL [--purge]" >&2; exit 2; }
root="$(cd "$(dirname "$0")/.." && pwd)"
state="$root/.superpowers/window/$label"

kill_tree() { local pid="$1" child; for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done; kill "$pid" 2>/dev/null || true; }
if [ -f "$state/pids" ]; then
  while read -r pid name; do [ -n "$pid" ] && kill_tree "$pid"; done < "$state/pids"
  rm -f "$state/pids"
  echo "stopped the processes of window '$label'"
else
  echo "no running processes recorded for window '$label'"
fi

compose=(docker compose -p "envio-${label}" -f "$root/envio/docker-compose.yaml" -f "$root/envio/window-${label}.compose.yaml")
if [ "$purge" = "--purge" ]; then
  export CONFIG_FILE="window-${label}.config.yaml"
  [ -f "$root/envio/window-${label}.compose.yaml" ] && "${compose[@]}" down -v 2>&1 | tail -3
  app_container="$(docker ps --format '{{.Names}}' | grep -E 'launchpad-aggregator-postgres' | head -1)"
  [ -n "$app_container" ] && docker exec "$app_container" psql -U launchpad -d postgres -c "DROP DATABASE IF EXISTS launchpad_${label}" 2>&1 | tail -1
  rm -f "$root/envio/window-${label}.config.yaml" "$root/envio/window-${label}.compose.yaml"
  rm -rf "$state"
  echo "purged window '$label'"
else
  [ -f "$root/envio/window-${label}.compose.yaml" ] && { export CONFIG_FILE="window-${label}.config.yaml"; "${compose[@]}" stop 2>&1 | tail -3; }
fi

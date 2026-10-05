#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPOSITORY_ROOT"

if command -v docker >/dev/null 2>&1; then
  if docker compose ps --status running -q app 2>/dev/null | grep -q .; then
    echo "Backup refused while the app is running; stop writes with 'docker compose stop app' first." >&2
    exit 1
  fi
  if docker compose ps --status running -q postgres 2>/dev/null | grep -q .; then
    exec docker compose run --rm backup "$@"
  fi
fi

exec node scripts/backup.mjs "$@"

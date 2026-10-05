#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPOSITORY_ROOT"

if command -v docker >/dev/null 2>&1; then
  if docker compose ps --status running -q app 2>/dev/null | grep -q .; then
    echo "Restore refused: stop the app first with 'docker compose stop app'." >&2
    exit 1
  fi
  if docker compose ps --status running -q postgres 2>/dev/null | grep -q .; then
    exec docker compose run --rm restore "$@"
  fi
fi

exec node scripts/restore.mjs "$@"

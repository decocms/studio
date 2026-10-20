#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

trap 'docker compose -f "$COMPOSE_FILE" down -v' EXIT INT TERM

# Tests poll API readiness; one-shot migration/bucket services exit successfully.
docker compose -f "$COMPOSE_FILE" up -d --build

bun test "$SCRIPT_DIR/scenarios/" --serial --timeout 900000

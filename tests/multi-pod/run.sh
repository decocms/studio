#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

trap 'docker compose -f "$COMPOSE_FILE" down -v' EXIT INT TERM

# Bring everything up. We don't use --wait because the `migrate` service is a
# one-shot that exits 0 once schemas are created; --wait mis-classifies that
# as a failure. Instead, the test suite's setup hooks poll each pod's
# /health/live before scenarios run (see lib/cluster.ts:waitReady).
docker compose -f "$COMPOSE_FILE" up -d --build

bun test "$SCRIPT_DIR/scenarios/" --serial --timeout 900000

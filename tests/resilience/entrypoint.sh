#!/bin/bash
set -e

cd /app/apps/api

# Run all migrations (Kysely + Better Auth + plugins)
echo "Running migrations..."
bun run migrate 2>&1

echo "Starting server..."
exec bun run src/index.ts

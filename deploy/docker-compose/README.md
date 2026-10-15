# Local development

From the repository root, run `docker compose up --build --watch` (Compose 2.32+).
Open <http://localhost:4000>. Source changes sync into Linux containers; Bun/Vite
reload the application. Dependencies and generated sandbox packages stay in the
development image. Lockfile/manifests rebuild it. No host Bun installation is
needed for this workflow. Personal environment files are never copied or synced.
Sign up normally; loopback-only local auto-login is disabled across containers.

`docker compose logs -f api` shows API logs. After adding migrations, run
`docker compose build migrate && docker compose run --rm migrate`, then
`docker compose restart api`. Schema migration failures block initial startup.
`docker compose down` retains data; `down -v` deletes this project's volumes.
Existing managed-CLI data is not imported or deleted automatically.

Use `WEB_PORT=4001 COMPOSE_PROJECT_NAME=branch-a docker compose up --build --watch` for
an isolated second checkout. Keep the same project name/port for subsequent
commands. There are no fixed container names or required infrastructure host ports.
Development auth cookies use a project-specific prefix, so logging into another
localhost port does not replace the first worktree's session. Native clients
that require the default cookie names can set `BETTER_AUTH_COOKIE_PREFIX=better-auth`.
Compose does not provision agent sandboxes; configure an existing provider or use
the [local Kubernetes workflow](../../selfhost/examples/dev-hybrid/README.md).

For host-only API development, `docker-compose.dev.yml` exposes dependency ports;
configure `DATABASE_URL`, `NATS_URL`, and S3 settings before starting source commands.
When reusing a Compose database, keep the same `BETTER_AUTH_SECRET` and
`ENCRYPTION_KEY` in the host API; changing the auth secret breaks persisted JWKS.
For release images, use `docker-compose.postgres.yml`; its one-shot migration job
prepares the database before Studio starts. Override images and credentials for
your deployment. These local examples use development secrets by default.

## Sharing infrastructure between worktrees

This optional setup shares server processes, not application state. Provision
separate database roles/databases, NATS accounts, and buckets/credentials using
the standard service tools. There is no background Studio resource manager.

1. Copy `nats-shared.conf.example` to an ignored file outside the checkout.
   Replace the example passwords and add one account per worktree. Start the
   infrastructure once:

   ```sh
   NATS_CONFIG=/absolute/path/to/nats.conf docker compose -p studio-infra \
     -f deploy/docker-compose/docker-compose.dev.yml \
     -f deploy/docker-compose/compose.infra-shared.yaml up -d
   ```

   Allow at least 4 GiB of JetStream capacity per worktree, plus KV headroom.
   The example's 16 GB server limit supports its two accounts; it is a ceiling,
   not preallocated disk space. Verify each account has `DECOPILOT_STREAMS`:
   HTTP health alone does not prove agent output streaming is ready.

2. Use PostgreSQL's `createuser`/`createdb` (or `psql`) inside the `postgres`
   container to create a restricted role and its database per worktree. Use
   MinIO's `mc` to create each bucket, user and bucket-scoped policy. Existing
   NATS subjects are isolated by account; a different URL on the same account
   does not isolate them. After editing the NATS config, reload with
   `docker kill --signal=HUP <nats-container>`; existing accounts must remain.

3. Put each worktree's configuration in its ignored root `.env`:

   ```dotenv
   COMPOSE_FILE=compose.yaml:deploy/docker-compose/compose.shared.yaml
   COMPOSE_PROJECT_NAME=branch-a
   WEB_PORT=4001
   STUDIO_INFRA_NETWORK=studio-infra
   DATABASE_URL=postgresql://branch_a:replace-me@postgres:5432/branch_a
   NATS_URL=nats://nats:4222
   NATS_USER=branch_a
   NATS_PASSWORD=replace-me
   S3_ENDPOINT=http://minio:9000
   S3_BUCKET=branch-a
   S3_ACCESS_KEY_ID=replace-me
   S3_SECRET_ACCESS_KEY=replace-me
   ```

   Then run `docker compose up --build --watch`. Only application services and migrations
   start; local dependency services are disabled. Missing shared configuration
   fails before startup. URL-encode credentials used in connection URLs.

`docker compose down` in a worktree leaves infrastructure running. Remove only
that worktree's database/role, NATS account and bucket when retiring it. Never run
the infrastructure stack's `down -v` as worktree cleanup. This is local development
isolation among trusted contributors, not a hostile-code security boundary:
containers on the shared network can reach the shared services.

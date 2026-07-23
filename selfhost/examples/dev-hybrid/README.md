# Dev-hybrid: Studio source against the local cluster

Develop Studio **from source with hot reload**, while the **real backends and
sandbox** come from the k8s-local install. It's the loop for working on
sandbox/preview/k8s behavior — the pure `bun dev` loop can't do that (no
agent-sandbox operator on your laptop), and the pure cluster loop makes you
rebuild an image per change.

```
        your host                         local cluster (Rancher/k3d)
   ┌─────────────────┐              ┌──────────────────────────────────┐
   │ bun dev:servers  │  kubeconfig  │  agent-sandbox operator          │
   │ (web + API)      │─────────────▶│  + warm pool  (creates sandboxes,│
   │                  │  port-forward│    port-forward to daemon:9000)  │
   │  DATABASE_URL ───┼─────────────▶│  studio-db / studio-minio / nats │
   └─────────────────┘              │  (Studio app + worker scaled to 0)│
                                     └──────────────────────────────────┘
```

## Run (self-contained — one command)

```bash
./selfhost/examples/dev-hybrid/dev-hybrid.sh
# open http://localhost:4000 — edit apps/web or apps/api, save, it reloads
# Ctrl-C to stop (restores the in-cluster app, closes the forwards)
```

What it does:
1. **If the cluster isn't up, brings it up** — runs `local-k8s.sh` with
   `OBSERVABILITY=0` (core + sandbox; no in-cluster ClickHouse, since `bun dev`
   uses the local monitoring path). If it's already up, skips straight ahead.
2. Scales the in-cluster `deco-studio` app + worker to **0** (so the host process
   is the only one draining the shared DB/NATS run queue — no dueling workers).
   It uses `kubectl scale`, NOT helm, so the release + observability are untouched.
3. Port-forwards `studio-db:5432`, `studio-minio:9000`, `<release>-nats:4222`.
4. Exports **`.env`** (created from [`.env.example`](.env.example) on first run)
   and runs the **raw dev servers** — `bun run dev:servers` (Vite from
   `apps/web` + the real API server from `apps/api/src/index.ts`), after
   migrating from `apps/api`.

**Why not `bun run dev`?** That entrypoint is `deco dev --local-sandbox-provider`
— it spins up its OWN embedded Postgres/NATS and a LOCAL (laptop) sandbox,
ignoring these targets. The raw server `src/index.ts` instead honors
`DATABASE_URL`/`NATS_URL`/`STUDIO_SANDBOX_*` from the environment, so it connects
to the cluster's backends and the agent-sandbox provider.

## Configuring it — the `.env`

All the cluster-pointing config lives in `selfhost/examples/dev-hybrid/.env`
(copied from `.env.example` the first time; git-ignored). It's a real, documented
file you can edit — DB/NATS/S3 targets (the port-forward endpoints), the sandbox
provider + template + **sentinel token** (must match the umbrella's
`sandbox-env.sentinel.token`), and the app secrets/URLs.

The script exports this file into the environment before starting the servers.
There's no `apps/api/.env`, so `dev:server`'s own `--env-file=.env` is a no-op
and these values win — and it stays **separate from any repo-root `.env`** you
keep for the plain `bun dev` loop. Edit this `.env` to change what the host
process points at (e.g. set `CLICKHOUSE_URL` to also use an in-cluster ClickHouse,
or bump the ports).

## Why the sandbox works from your host

Studio's agent-sandbox provider loads your **kubeconfig** (`~/.kube/config`, the
Rancher context = admin), so it satisfies the sandbox RBAC and creates
`SandboxClaim`s in `agent-sandbox-system`. It reaches each sandbox daemon over
the **API server's port-forward** (not in-cluster Service DNS), which is exactly
what your host can reach. The sentinel token is passed as
`STUDIO_SANDBOX_SENTINEL_TOKEN` (same fixed value the umbrella wires) so Studio runs
in warm-pool mode.

## Database version skew

The cluster's `studio-db` is migrated by the **in-cluster image** at install; the
hybrid runs your **source checkout**. If they differ, `migrate` behaves like so:

- **Source behind the image** (image has migrations you don't) → `migrate` errors
  `corrupted migrations: … is missing`. The script treats this as non-fatal: the
  DB is already ahead, nothing to apply, and the server runs fine against it.
- **Source ahead** (you added migrations) → `migrate` applies them. Fine.

For a **clean, source-owned schema** (recommended if your checkout diverged),
wipe + re-migrate the DB once — this drops the data (org/user) in it:

```bash
RESET_DB=1 ./selfhost/examples/dev-hybrid/dev-hybrid.sh   # source migrates from scratch; re-signup
```

After a reset, plain re-runs are idempotent (the source owns the schema).

## Caveats

- **Previews** are best-effort here. The pattern is set to
  `http://{handle}.preview.localhost:4000`, served by the dev server's in-process
  proxy. Sandbox **code-execution** always works; if a preview URL doesn't route
  in dev, that's the front-door host-routing the container's nginx does in the
  full k8s path — add a tiny local Traefik/nginx if you need URL parity, or use
  the full k8s-local install to exercise previews.
- **Monitoring**: `CLICKHOUSE_URL` is left unset, so `bun dev` uses its local
  DuckDB + NDJSON path (no in-cluster ClickHouse needed for the hybrid).
- Secrets are dev fixtures (`ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`) in `.env` —
  edit that file to change them. `VITE_PORT` (default 4000) sets the printed UI
  URL; if you change the port, also update `BASE_URL`/`BETTER_AUTH_URL`/the
  preview pattern in `.env`.

For iterating on **app logic only** (no sandbox), the lighter loop is plain
`bun run dev` (embedded Postgres) — see [`../../../CLAUDE.md`](../../../CLAUDE.md).

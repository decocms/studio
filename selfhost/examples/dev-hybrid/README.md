# Dev-hybrid: Studio source against the local cluster

Develop Studio **from source with hot reload**, while the **real backends and
sandbox** come from the k8s-local install. It's the loop for working on
Kubernetes sandbox/preview behavior — the pure `bun run dev` loop runs sandboxes
on the sandbox controller's docker runtime instead (no agent-sandbox operator on
your laptop), and the pure cluster loop makes you rebuild an image per change.

```
        your host                          local cluster (Rancher/k3d)
   ┌───────────────────┐             ┌──────────────────────────────────┐
   │ bun dev:servers   │    mTLS     │  agent-sandbox operator          │
   │ (web + API) ──────┼──┐          │  + warm pool                     │
   │ sandbox controller│◀─┘kubeconfig│  (SandboxClaims; port-forward    │
   │ (go run)  ────────┼────────────▶│   to daemon:9000)                │
   │  DATABASE_URL ────┼────────────▶│  studio-db / studio-minio / nats │
   └───────────────────┘ port-forward│  (Studio app, worker, controller │
                                     │   scaled to 0)                   │
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
2. Scales the in-cluster `deco-studio` app + worker + sandbox controller to
   **0** (so the host processes are the only ones draining the shared DB/NATS
   run queue and writing sandbox state — no dueling workers). It uses
   `kubectl scale`, NOT helm, so the release + observability are untouched.
3. Port-forwards `studio-db:5432`, `studio-minio:9000`, `<release>-nats:4222`.
4. Exports **`.env`** (created from [`.env.example`](.env.example) on first run),
   migrates from `apps/api`, writes a throwaway CA + controller/Studio
   certificates into `.sandbox-controller/`, starts the **sandbox controller**
   from source (`go run`, kubernetes runtime, claim API on `127.0.0.1:7443`), and
   runs the **raw dev servers** — Vite from `apps/web` + the real API server from
   `apps/api/src/index.ts` — with `STUDIO_SANDBOX_CONTROLLER_*` pointing at it.

Needs `go` and `openssl` on the host besides `kubectl`, `helm` and `bun`.

**Why not `bun run dev`?** That entrypoint is `deco dev` — it spins up its OWN
embedded Postgres/NATS and a docker-runtime controller, ignoring these targets.
The raw server `src/index.ts` instead honors
`DATABASE_URL`/`NATS_URL`/`STUDIO_SANDBOX_*` from the environment, so it connects
to the cluster's backends and the host sandbox controller.

## Configuring it — the `.env`

All the cluster-pointing config lives in `selfhost/examples/dev-hybrid/.env`
(copied from `.env.example` the first time; git-ignored). It's a real, documented
file you can edit — DB/NATS/S3 targets (the port-forward endpoints), the
sandbox **sentinel token** the host controller reads (must match the umbrella's
`sandbox-env.sentinel.token`), and the app secrets/URLs. The controller
connection (`STUDIO_SANDBOX_CONTROLLER_*`) is not in it: the script sets it for
the certificates it just generated. `CONTROLLER_PORT` / `CALLBACK_PORT` move the
claim API and Studio's callback listener; `SANDBOX_TEMPLATE` /
`SANDBOX_ENV_NAME` default to the umbrella's `studio-sandbox-local` / `local`.

The script exports this file into the environment before starting the servers.
There's no `apps/api/.env`, so `dev:server`'s own `--env-file=.env` is a no-op
and these values win — and it stays **separate from any repo-root `.env`** you
keep for the plain `bun dev` loop. Edit this `.env` to change what the host
process points at (e.g. set `CLICKHOUSE_URL` to also use an in-cluster ClickHouse,
or bump the ports).

## Why the sandbox works from your host

Studio holds no cluster access; it asks the sandbox controller over mTLS. The
host controller loads your **kubeconfig** (`~/.kube/config`, the Rancher
context = admin), so it can create `SandboxClaim`s in `agent-sandbox-system`.
It runs without `--preview-url-pattern`, so it reaches each sandbox daemon over
the **API server's port-forward** (not in-cluster Service DNS) and hands Studio
that local address — which only works because Studio shares its host. The
in-cluster controller is scaled to 0 for the same reason: the daemon addresses
it hands out and its callbacks to the in-cluster Studio are unreachable from the
host. The controller reads `STUDIO_SANDBOX_SENTINEL_TOKEN` (same fixed value the
umbrella wires) so claims use the warm pool.

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

For iterating without the cluster, the lighter loop is plain `bun run dev`
(embedded Postgres) — see [`../../../CLAUDE.md`](../../../CLAUDE.md). With
`STUDIO_AGENT_SANDBOX_ENABLED=true` and no `STUDIO_SANDBOX_CONTROLLER_URL`, it
runs the sandbox controller on the docker runtime itself; without Go, OpenSSL or
a working `docker version` it skips the controller and sandbox tools answer 503
saying what to install.

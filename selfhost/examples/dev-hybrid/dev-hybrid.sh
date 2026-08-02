#!/usr/bin/env bash
#
# dev-hybrid.sh — develop Studio from source (hot reload) against the LOCAL
# cluster's real backends and sandbox. Best of both loops:
#   • the API + web apps run on your host via `bun run dev:servers`, and
#   • Postgres / NATS / MinIO / agent-sandbox all come from the k8s-local install,
#     so sandbox code-exec + previews exercise the real operator — impossible in
#     the pure `bun dev` loop (no operator on your laptop).
#
# How it works: it ensures the k8s-local umbrella is up (installs it if missing —
# without in-cluster ClickHouse, since `bun dev` uses the local monitoring path),
# scales the in-cluster Studio app + worker to 0 (so they don't duel the host
# process over the same DB/NATS run queue), port-forwards the cluster's backend
# Services to localhost, and launches the raw dev servers pointed at them. On
# exit, the port-forwards are torn down and the in-cluster app is scaled back
# to 1.
#
# Self-contained: no prerequisite step. Bringing up the cluster (if needed) uses
# the same local-k8s.sh; the Helm release / observability are otherwise untouched
# — this script only scales the app Deployments and port-forwards.
#
# Usage:
#   ./selfhost/examples/dev-hybrid/dev-hybrid.sh
#   (Ctrl-C to stop — restores the in-cluster app and closes the forwards.)
#
set -euo pipefail

NAMESPACE="${NAMESPACE:-deco-studio}"
RELEASE="${RELEASE:-deco-studio}"
VITE_PORT="${VITE_PORT:-4000}"   # only for the printed UI URL; real config is in .env

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
LOCAL_K8S="${REPO_ROOT}/selfhost/scripts/local-k8s.sh"

command -v kubectl >/dev/null || { echo "kubectl not found" >&2; exit 1; }
command -v bun     >/dev/null || { echo "bun not found" >&2; exit 1; }
command -v helm    >/dev/null || { echo "helm not found" >&2; exit 1; }

# Self-contained: if the umbrella isn't up yet, bring it up (core + sandbox, no
# in-cluster ClickHouse — the host `bun dev` uses the local monitoring path).
if ! kubectl -n "${NAMESPACE}" get deploy "${RELEASE}" >/dev/null 2>&1; then
  echo "==> ${RELEASE} not found — bringing up the local cluster (core + sandbox)"
  OBSERVABILITY=0 "${LOCAL_K8S}"
fi

PF_PIDS=()
cleanup() {
  echo ""
  echo "==> Stopping port-forwards"
  for pid in "${PF_PIDS[@]:-}"; do kill "${pid}" 2>/dev/null || true; done
  echo "==> Restoring in-cluster Studio app (scale back to 1)"
  kubectl -n "${NAMESPACE}" scale deploy/"${RELEASE}" deploy/"${RELEASE}"-worker --replicas=1 >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "==> Scaling the in-cluster Studio app + worker to 0 (host process takes over)"
kubectl -n "${NAMESPACE}" scale deploy/"${RELEASE}" deploy/"${RELEASE}"-worker --replicas=0

echo "==> Waiting for backend Services to be ready"
kubectl -n "${NAMESPACE}" rollout status deploy/studio-db --timeout=120s || true
kubectl -n "${NAMESPACE}" rollout status deploy/studio-minio --timeout=120s || true
kubectl -n "${NAMESPACE}" rollout status statefulset/"${RELEASE}"-nats --timeout=120s 2>/dev/null || true

echo "==> Port-forwarding cluster backends to localhost"
kubectl -n "${NAMESPACE}" port-forward svc/studio-db 5432:5432        >/dev/null 2>&1 & PF_PIDS+=($!)
kubectl -n "${NAMESPACE}" port-forward svc/studio-minio 9000:9000     >/dev/null 2>&1 & PF_PIDS+=($!)
kubectl -n "${NAMESPACE}" port-forward svc/"${RELEASE}"-nats 4222:4222 >/dev/null 2>&1 & PF_PIDS+=($!)
sleep 3   # let the forwards establish before the app dials them

echo "==> Starting Studio from source (bun run dev) against the cluster"
echo "    UI: http://localhost:${VITE_PORT}   (hot reload; sandbox from the cluster)"
echo ""

# Studio loads ~/.kube/config (your Rancher context, admin) for the agent-sandbox
# provider, so it creates SandboxClaims + port-forwards to the daemon in
# agent-sandbox-system straight from the host. Backends point at the forwards.
cd "${REPO_ROOT}"

# Workspace deps (e.g. @decocms/shared from packages/shared) must be linked into
# node_modules for the dev server to resolve them. Link them if missing.
if [ ! -e node_modules/@decocms/shared ]; then
  echo "==> Linking workspace deps (bun install) — first run only"
  bun install
fi

# All the cluster-pointing config lives in a real, editable env file (copied from
# .env.example on first run) — visible + tweakable. Edit ${ENV_FILE} to change
# DB/S3/sandbox targets.
ENV_FILE="${SCRIPT_DIR}/.env"
if [ ! -f "${ENV_FILE}" ]; then
  echo "==> Creating ${ENV_FILE} from .env.example (edit it to tweak the config)"
  cp "${SCRIPT_DIR}/.env.example" "${ENV_FILE}"
fi

# Run the RAW dev servers (Vite client + the real server src/index.ts), NOT
# `bun run dev` / scripts/dev.ts — that one is the embedded orchestrator
# (`deco dev`) which spins up its OWN Postgres/NATS, ignoring these targets.
# src/index.ts instead honors
# DATABASE_URL / NATS_URL / STUDIO_SANDBOX_* from the environment, so it connects
# to the cluster (via the port-forwards) and the agent-sandbox provider.
# We export ${ENV_FILE} into the environment; there's no apps/api/.env, so the
# API dev server's own `--env-file=.env` is a no-op and these values win.
echo "==> Config: ${ENV_FILE}"
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

# RESET_DB=1: wipe the cluster's `studio` database so THIS source owns the schema
# from scratch (use when your checkout diverged from the in-cluster image and you
# want a clean, source-migrated DB). Destroys the data (org/user) in that DB.
if [ "${RESET_DB:-0}" = "1" ]; then
  echo "==> RESET_DB=1 — dropping + recreating the cluster 'studio' database"
  DB_POD="$(kubectl -n "${NAMESPACE}" get pod -l app=studio-db -o name 2>/dev/null | head -1 | sed 's|pod/||')"
  if [ -n "${DB_POD}" ]; then
    # dropdb/createdb run outside a transaction (a multi-statement `psql -c` would
    # fail: "DROP DATABASE cannot run inside a transaction block"). --force (PG13+)
    # terminates open connections first.
    kubectl -n "${NAMESPACE}" exec "${DB_POD}" -- dropdb -U studio --if-exists --force studio || true
    kubectl -n "${NAMESPACE}" exec "${DB_POD}" -- createdb -U studio -O studio studio || true
  fi
fi

# Apply the source tree's migrations to the cluster DB. Best-effort: if the DB
# was migrated by a NEWER in-cluster image than this checkout, kysely reports
# "corrupted migrations: ... is missing" — that only means the DB is already
# ahead of the source, so there's nothing to apply; warn and proceed (the server
# runs fine against the newer schema). It only truly matters the other way (your
# source ADDED migrations), and then this succeeds.
echo "==> Applying source migrations to the cluster DB (best-effort)"
if ! bun run --cwd=apps/api migrate; then
  echo "    NOTE: migrate skipped — the cluster DB was migrated by a newer/different"
  echo "    Studio version than this checkout. Proceeding against the existing schema."
  echo "    For a source-owned schema, reset it:  RESET_DB=1 re-run (see README)."
fi
echo "==> Starting Vite + server (src/index.ts) against the cluster"
bun run dev:servers

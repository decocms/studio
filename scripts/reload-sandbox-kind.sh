#!/usr/bin/env bash
# Rebuild the studio-sandbox daemon + image, load it into the local kind
# cluster, and recycle sandbox pods so the warm pool respawns on the new
# image. Run from anywhere: `./scripts/reload-sandbox-kind.sh`.
set -euo pipefail

CLUSTER=studio-sandbox-dev
# Pinned: the default kubectl context is usually prod (eks-*), never rely on it.
CONTEXT=kind-studio-sandbox-dev
NS=agent-sandbox-system
IMAGE=studio-sandbox:local

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

echo "==> building daemon bundle"
bun run --cwd packages/sandbox build

echo "==> building image $IMAGE"
docker build -t "$IMAGE" -f packages/sandbox/image/Dockerfile packages/sandbox

echo "==> loading into kind ($CLUSTER)"
kind load docker-image "$IMAGE" --name "$CLUSTER"

echo "==> recycling sandbox pods (warm pool respawns on the new image)"
kubectl --context "$CONTEXT" -n "$NS" delete sandboxclaim --all --ignore-not-found
kubectl --context "$CONTEXT" -n "$NS" delete sandbox --all --ignore-not-found

echo "==> done. pods:"
kubectl --context "$CONTEXT" -n "$NS" get pods 2>/dev/null | grep -vE "controller|housekeeper" || true

#!/usr/bin/env bash
# Delete all sandbox claims, then all sandboxes, on the local kind cluster.
# ponytail: hardcoded to kind-studio-sandbox-dev so it can never hit a prod context.
set -euo pipefail

CTX=kind-studio-sandbox-dev
NS=agent-sandbox-system

kubectl --context="$CTX" -n "$NS" delete sandboxclaims --all --ignore-not-found
kubectl --context="$CTX" -n "$NS" delete sandboxes --all --ignore-not-found

echo "done. remaining (warmpool may have recreated fresh members):"
kubectl --context="$CTX" -n "$NS" get sandboxclaims,sandboxes 2>&1

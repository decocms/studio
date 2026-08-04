#!/usr/bin/env bash
#
# reload-sandbox.sh — push in-sandbox code changes into the local cluster.
#
# dev-hybrid hot-reloads everything that runs on your host (apps/api, apps/web,
# packages/sandbox/server/**). This script is for the other half: the code that
# runs INSIDE the sandbox pod and is therefore baked into its image —
#
#   packages/sandbox/daemon-go/**     the Go daemon
#   packages/harness-runner/**        the in-pod harness runner (claude-code)
#   packages/sandbox/image/**         the Dockerfile + bundled skills
#   packages/typegen/**               packed into the image
#
# Rebuilds the image and recycles the sandboxes so the next run picks it up.
# No push, no `kind load`: this k3s node's runtime IS dockerd (Rancher Desktop
# in moby mode), so a local `docker build` is immediately visible to kubelet.
#
# Usage:
#   ./selfhost/examples/dev-hybrid/reload-sandbox.sh
#   IMAGE=studio-sandbox:my-tag ./selfhost/examples/dev-hybrid/reload-sandbox.sh
#
set -euo pipefail

NAMESPACE="${SANDBOX_NAMESPACE:-agent-sandbox-system}"
TEMPLATE="${STUDIO_SANDBOX_TEMPLATE_NAME:-studio-sandbox-local}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

command -v kubectl >/dev/null || { echo "kubectl not found" >&2; exit 1; }
command -v docker  >/dev/null || { echo "docker not found" >&2; exit 1; }

# The SandboxTemplate is the source of truth for which tag pods actually run.
# Defaulting to it (rather than a hardcoded tag) is what keeps a rebuild from
# silently landing on an image nothing uses.
TEMPLATE_IMAGE="$(kubectl -n "${NAMESPACE}" get sandboxtemplate "${TEMPLATE}" \
  -o jsonpath='{.spec.podTemplate.spec.containers[0].image}' 2>/dev/null || true)"
if [ -z "${TEMPLATE_IMAGE}" ]; then
  echo "ERROR: SandboxTemplate ${NAMESPACE}/${TEMPLATE} not found — is the local cluster up?" >&2
  echo "  bring it up with: OBSERVABILITY=0 ./selfhost/scripts/local-k8s.sh" >&2
  exit 1
fi
IMAGE="${IMAGE:-${TEMPLATE_IMAGE}}"
if [ "${IMAGE}" != "${TEMPLATE_IMAGE}" ]; then
  echo "WARNING: building ${IMAGE}, but ${TEMPLATE} runs ${TEMPLATE_IMAGE}." >&2
  echo "  New pods will NOT use this build. Point the template at it, or drop IMAGE." >&2
fi
case "${IMAGE}" in
  *:*) ;;
  *) echo "ERROR: IMAGE must be tagged (got ${IMAGE}) — an untagged build lands on :latest" >&2; exit 1 ;;
esac

# The image copies these tarballs in, so they have to be repacked from source
# first — a stale dist/ is how a rebuilt image ships yesterday's runner.
echo "==> Packing sandbox tarballs (harness-runner + typegen)"
bun run --cwd="${REPO_ROOT}/packages/sandbox" build

echo "==> Building ${IMAGE}"
docker build -t "${IMAGE}" \
  -f "${REPO_ROOT}/packages/sandbox/image/Dockerfile" \
  "${REPO_ROOT}/packages/sandbox"

# Same tag + imagePullPolicy: IfNotPresent means kubelet already resolves to the
# new local image — only the pods holding the old one need replacing. Studio
# reprovisions on the next run (404 -> 410), and the operator refills the warm
# pool on its own.
echo "==> Recycling sandboxes in ${NAMESPACE}"
kubectl -n "${NAMESPACE}" delete sandbox --all

NEW_ID="$(docker images -q "${IMAGE}" | head -1)"
echo "==> Waiting for a warm sandbox on ${NEW_ID}"

# Match on the resolved image ID, not on `Running`: a pod being torn down still
# reports Running for a few seconds, so a phase-only check goes green while the
# old image is still what's serving. The old pods carry the old ID, so this
# filter excludes them without having to reason about deletionTimestamp.
podsOnNewImage() {
  kubectl -n "${NAMESPACE}" get pods -l "app.kubernetes.io/name=${TEMPLATE}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.phase}{" "}{range .status.containerStatuses[?(@.name=="sandbox")]}{.imageID}{end}{"\n"}{end}' \
    2>/dev/null | awk -v id="${NEW_ID}" '$2 == "Running" && index($3, id) { print $1 }'
}

for _ in $(seq 1 60); do
  READY="$(podsOnNewImage)"
  [ -n "${READY}" ] && break
  sleep 3
done
if [ -z "${READY:-}" ]; then
  echo "    NOTE: no warm sandbox on the new image yet. The warm pool may be disabled —"
  echo "    the next run provisions one on demand and will still use ${IMAGE}."
  echo "    Check: kubectl -n ${NAMESPACE} get pods"
  exit 0
fi
echo "${READY}" | sed 's/^/    /'
echo "==> Done. Image ${IMAGE} (${NEW_ID}) is live for the next run."

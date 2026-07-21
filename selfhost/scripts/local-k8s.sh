#!/usr/bin/env bash
#
# local-k8s.sh — install deco Studio on a local Kubernetes cluster (Rancher
# Desktop / kind / minikube) with ONE `helm install`.
#
# Thin wrapper over the umbrella chart at selfhost/examples/k8s-local, which
# declares everything as Helm dependencies — Studio (+ bundled NATS), the
# agent-sandbox operator, sandbox-env — and adds throwaway PostgreSQL + MinIO as
# its own templates. No scattered `kubectl apply` steps: the chart owns it all.
#
# The umbrella installs the full sandbox layer by default (code-execution +
# previews). The studio-sandbox RUNTIME image is multi-arch (arm64 + amd64) from
# tag 1.17.3, so running a sandbox works natively on Apple Silicon.
#
# Idempotent: re-run it any time (fresh install or upgrade) — it resolves deps,
# `helm upgrade --install`s, waits for rollout, and bounces any stuck sandbox
# pool pods. No manual helm/kubectl steps needed.
#
# Usage:
#   ./selfhost/scripts/local-k8s.sh                  # install/upgrade EVERYTHING (warm pool on)
#   WARMPOOL=0 ./selfhost/scripts/local-k8s.sh       # everything except the warm pool
#   WARMPOOL_SIZE=3 ./selfhost/scripts/local-k8s.sh  # resize the warm pool
#   OBSERVABILITY=1 ./selfhost/scripts/local-k8s.sh  # + in-cluster ClickHouse + OTel collector (opt-in)
#   ./selfhost/scripts/local-k8s.sh uninstall        # remove EVERYTHING
#
set -euo pipefail

NAMESPACE="${NAMESPACE:-deco-studio}"
RELEASE="${RELEASE:-deco-studio}"   # keep = deco-studio: derived names/SA depend on it
SANDBOX_NS="agent-sandbox-system"
ENVNAME="${ENVNAME:-local}"         # sandbox-env envName (umbrella default: local)
# Warm pool is ON by default in the umbrella (studio-sandbox 1.17.3 is multi-arch).
# Leave WARMPOOL unset to keep it on; set WARMPOOL=0 to disable, or WARMPOOL_SIZE=N.
WARMPOOL="${WARMPOOL:-}"
WARMPOOL_SIZE="${WARMPOOL_SIZE:-}"
# In-cluster ClickHouse (monitoring dashboard) + OTel collector. OFF by default:
# the clickhouse.com operator's version-probe races Job-pod GC on older k8s
# (e.g. Rancher Desktop's k8s 1.25), leaving the collector crashlooping and no
# ClickHouse — so it's opt-in. Set OBSERVABILITY=1 to install it (two-phase,
# because the operator ships its CRDs as templates, not in crds/).
OBSERVABILITY="${OBSERVABILITY:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CHART_DIR="${REPO_ROOT}/selfhost/examples/k8s-local"
OBS_VALUES="${CHART_DIR}/observability.yaml"

# --------------------------------------------------------------------------
# Teardown — removes EVERYTHING this chart creates (both namespaces).
# --------------------------------------------------------------------------
if [ "${1:-}" = "uninstall" ]; then
  echo "==> Uninstalling ${RELEASE}"
  helm uninstall "${RELEASE}" -n "${NAMESPACE}" 2>/dev/null || true
  kubectl delete namespace "${NAMESPACE}" --wait=false 2>/dev/null || true
  kubectl delete namespace "${SANDBOX_NS}" --wait=false 2>/dev/null || true
  echo "Done. Cluster-scoped CRDs survive the uninstall; remove them with:"
  echo "  kubectl get crd -o name | grep -E 'agents.x-k8s.io|clickhouse.com' | xargs -r kubectl delete"
  exit 0
fi

command -v kubectl >/dev/null || { echo "kubectl not found" >&2; exit 1; }
command -v helm    >/dev/null || { echo "helm not found" >&2; exit 1; }

echo "==> Context: $(kubectl config current-context)"
# A prior `uninstall` deletes the namespace with --wait=false, so a quick
# re-install can race a still-Terminating namespace. Wait for it to clear first.
if [ "$(kubectl get ns "${NAMESPACE}" -o jsonpath='{.status.phase}' 2>/dev/null || true)" = "Terminating" ]; then
  echo "==> Namespace ${NAMESPACE} is Terminating; waiting for it to clear..."
  kubectl wait --for=delete ns/"${NAMESPACE}" --timeout=120s || true
fi

echo "==> Resolving chart dependencies (Studio + sandbox + NATS)"
# `build` is fast/offline and uses Chart.lock; but if a deploy/ chart bumped its
# version the locked version no longer resolves, so fall back to `update` which
# re-resolves the local file:// charts and regenerates the lock. This keeps the
# example tracking the deploy/ charts as they evolve, no manual version edits.
helm dependency build "${CHART_DIR}" >/dev/null 2>&1 || helm dependency update "${CHART_DIR}" >/dev/null

WARMPOOL_ARGS=()
if [ "${WARMPOOL}" = "0" ]; then
  echo "==> Warm pool DISABLED (WARMPOOL=0)"
  WARMPOOL_ARGS=(--set sandbox-env.warmPool.enabled=false)
elif [ -n "${WARMPOOL_SIZE}" ]; then
  echo "==> Warm pool size override: ${WARMPOOL_SIZE}"
  WARMPOOL_ARGS=(--set sandbox-env.warmPool.size="${WARMPOOL_SIZE}")
fi
# Default (unset): umbrella keeps warm pool on with size 1.

# Observability overlay (in-cluster ClickHouse + OTel collector).
OBS_ARGS=()
[ "${OBSERVABILITY}" = "1" ] && { echo "==> Observability ENABLED (ClickHouse + OTel collector)"; OBS_ARGS=(-f "${OBS_VALUES}"); }

# CRD ordering: the clickhouse-operator ships its CRDs as templates, not in crds/,
# so on the FIRST install (CRD absent) the ClickHouseCluster CR can't co-install
# with its own CRD. Only then do a one-time two-phase: install with the CR OFF so
# the operator + CRD land, then enable the CR. When the CRD already exists (every
# re-run), install in ONE pass with the CR on — never disabling it, so a running
# ClickHouse is not torn down.
TWO_PHASE=0
if [ "${OBSERVABILITY}" = "1" ] && ! kubectl get crd clickhouseclusters.clickhouse.com >/dev/null 2>&1; then
  TWO_PHASE=1
fi
PHASE1_EXTRA=()
[ "${TWO_PHASE}" = "1" ] && PHASE1_EXTRA=(--set chart-deco-studio.clickhouse-cluster.enabled=false)

echo "==> Installing the umbrella (one release, everything)"
helm upgrade --install "${RELEASE}" "${CHART_DIR}" \
  -n "${NAMESPACE}" --create-namespace \
  ${OBS_ARGS[@]+"${OBS_ARGS[@]}"} \
  ${WARMPOOL_ARGS[@]+"${WARMPOOL_ARGS[@]}"} \
  ${PHASE1_EXTRA[@]+"${PHASE1_EXTRA[@]}"}

if [ "${TWO_PHASE}" = "1" ]; then
  echo "==> First install: waiting for the ClickHouse CRD, then enabling the CR"
  kubectl wait --for condition=established \
    crd/clickhouseclusters.clickhouse.com --timeout=120s || true
  helm upgrade "${RELEASE}" "${CHART_DIR}" -n "${NAMESPACE}" \
    ${OBS_ARGS[@]+"${OBS_ARGS[@]}"} \
    ${WARMPOOL_ARGS[@]+"${WARMPOOL_ARGS[@]}"}
fi

echo "==> Waiting for Studio to roll out (first image pull can take minutes)"
kubectl -n "${NAMESPACE}" rollout status deploy/"${RELEASE}" --timeout=300s || true
kubectl -n "${NAMESPACE}" rollout status deploy/"${RELEASE}"-worker --timeout=300s || true

# Self-heal the warm pool: sandbox pool pods mount the sentinel Secret + read the
# SandboxTemplate via secretKeyRef, but a `helm upgrade` that fixes either does
# NOT restart an already-stuck pool pod (Helm only re-rolls Deployments on
# template change; the operator won't recreate a pod that's merely CrashLooping).
# Delete any not-Running pool pod so the operator recreates it against the
# corrected spec. No-op on a clean install (nothing stuck to delete).
if [ "${WARMPOOL}" != "0" ]; then
  stuck="$(kubectl -n "${SANDBOX_NS}" get pods \
    -l "app.kubernetes.io/name=studio-sandbox-${ENVNAME}" \
    --field-selector 'status.phase!=Running' \
    -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)"
  if [ -n "${stuck}" ]; then
    echo "==> Bouncing not-ready sandbox pool pods: ${stuck}"
    # shellcheck disable=SC2086
    kubectl -n "${SANDBOX_NS}" delete pod ${stuck} --wait=false 2>/dev/null || true
  fi
fi

# Monitoring view: the collector creates + fills `otel_logs`; the dashboard reads
# a `studio_monitoring_logs` VIEW over it. Provision it here (idempotent) once
# ClickHouse is up and otel_logs exists — so the dashboard works with no manual
# clickhouse-setup.md step. Done in the script (not a Helm hook) so it can wait
# for readiness without blocking/failing the helm release.
if [ "${OBSERVABILITY}" = "1" ]; then
  echo "==> Provisioning the studio_monitoring_logs view (waits for ClickHouse + otel_logs)"
  CH_POD="$(kubectl -n "${NAMESPACE}" get pod -o name 2>/dev/null \
    | grep -m1 'clickhouse-cluster-clickhouse-[0-9]' | sed 's|pod/||' || true)"
  if [ -n "${CH_POD}" ]; then
    kubectl -n "${NAMESPACE}" wait --for=condition=ready "pod/${CH_POD}" --timeout=180s 2>/dev/null || true
  fi
  VIEW_DDL="CREATE OR REPLACE VIEW studio_monitoring_logs AS SELECT SpanId AS id, LogAttributes['studio.monitoring.organization_id'] AS organization_id, LogAttributes['studio.monitoring.connection_id'] AS connection_id, LogAttributes['studio.monitoring.connection_title'] AS connection_title, LogAttributes['studio.monitoring.tool_name'] AS tool_name, LogAttributes['studio.monitoring.input'] AS input, LogAttributes['studio.monitoring.output'] AS output, LogAttributes['studio.monitoring.is_error'] = 'true' AS is_error, LogAttributes['studio.monitoring.error_message'] AS error_message, toFloat64OrZero(LogAttributes['studio.monitoring.duration_ms']) AS duration_ms, Timestamp AS timestamp, LogAttributes['studio.monitoring.user_id'] AS user_id, LogAttributes['studio.monitoring.request_id'] AS request_id, LogAttributes['studio.monitoring.user_agent'] AS user_agent, LogAttributes['studio.monitoring.virtual_mcp_id'] AS virtual_mcp_id, LogAttributes['studio.monitoring.properties'] AS properties FROM otel_logs WHERE ServiceName = 'studio' AND LogAttributes['studio.monitoring.type'] IN ('tool_call', 'llm_call');"
  provisioned=0
  # otel_logs appears on the collector's first export (seconds after Studio boots).
  for _ in $(seq 1 30); do
    CH_POD="$(kubectl -n "${NAMESPACE}" get pod -o name 2>/dev/null \
      | grep -m1 'clickhouse-cluster-clickhouse-[0-9]' | sed 's|pod/||' || true)"
    if [ -n "${CH_POD}" ] && \
       kubectl -n "${NAMESPACE}" exec "${CH_POD}" -- clickhouse-client -q "EXISTS TABLE otel_logs" 2>/dev/null | grep -q 1; then
      if kubectl -n "${NAMESPACE}" exec "${CH_POD}" -- clickhouse-client -q "${VIEW_DDL}" 2>/dev/null; then
        echo "    studio_monitoring_logs view provisioned."
        provisioned=1
        break
      fi
    fi
    sleep 6
  done
  [ "${provisioned}" = "1" ] || echo "    NOTE: otel_logs not ready yet — re-run the script once Studio has emitted telemetry to create the view."
fi

echo ""
kubectl -n "${NAMESPACE}" get pods
echo ""
# Access — port-forward ALWAYS works. The LoadBalancer URL works only if the LB
# actually claimed the host :80; on stock Rancher Desktop, k3s Traefik's servicelb
# already owns :80, so Studio's LB stays <pending> and studio.localhost hits
# Traefik (404). Detect and print the honest primary path.
LB_ADDR="$(kubectl -n "${NAMESPACE}" get svc "${RELEASE}" \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
echo "Access:"
echo "  # Always works, any cluster:"
echo "  kubectl -n ${NAMESPACE} port-forward svc/${RELEASE} 8080:80   # → http://localhost:8080"
if [ -n "${LB_ADDR}" ]; then
  echo "  # LoadBalancer is up (${LB_ADDR}) — also reachable at http://studio.localhost"
else
  echo "  # LoadBalancer is <pending> (k3s Traefik likely owns :80). Use the port-forward"
  echo "  # above, OR disable Traefik (rdctl set --kubernetes.options.traefik=false) / front"
  echo "  # it with an ingress to serve http://studio.localhost directly."
fi
echo "  # then open the URL and sign up — first user becomes org owner"
echo ""
echo "Tear down everything:  ${BASH_SOURCE[0]} uninstall"

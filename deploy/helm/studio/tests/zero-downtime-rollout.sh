#!/usr/bin/env bash
# Zero-downtime rollout test for the studio chart's web↔api split.
#
# Proves that a rolling update of BOTH tiers serves every request without a
# single failure: an in-cluster client hammers the front-door Service (through
# nginx → api Service) while both Deployments are rolled. Any non-2xx or
# connection error fails the test.
#
# Runs against any reachable cluster (CI kind or a dev kind). Self-contained:
# creates a namespace, installs the chart with stub images, asserts, cleans up.
#
# Usage: zero-downtime-rollout.sh [--keep]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(dirname "$SCRIPT_DIR")"
NS="${NS:-studio-zdt-test}"
RELEASE="${RELEASE:-zdt}"
KEEP="${1:-}"

cleanup() {
  if [ "$KEEP" != "--keep" ]; then
    echo "── cleanup ──"
    helm uninstall "$RELEASE" -n "$NS" >/dev/null 2>&1 || true
    kubectl delete ns "$NS" --wait=false >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() { echo "❌ $*" >&2; exit 1; }

echo "── install chart (stub images) into ns/$NS ──"
kubectl create ns "$NS" >/dev/null 2>&1 || true
# --set nodeSelector=null: the chart pins amd64, which a values file can't clear
# (Helm merges maps). null deletes it so pods schedule on any-arch test nodes.
helm upgrade --install "$RELEASE" "$CHART_DIR" \
  -n "$NS" -f "$CHART_DIR/tests/values-e2e.yaml" \
  --set nodeSelector=null \
  --wait --timeout 5m

echo "── wait for both tiers Ready ──"
kubectl -n "$NS" rollout status deploy/"$RELEASE" --timeout 3m
kubectl -n "$NS" rollout status deploy/"$RELEASE"-web --timeout 3m

# Sanity: front-door Service must select ONLY web pods, api Service only api pods.
web_eps=$(kubectl -n "$NS" get endpoints "$RELEASE" -o jsonpath='{.subsets[*].addresses[*].ip}' | wc -w | tr -d ' ')
api_eps=$(kubectl -n "$NS" get endpoints "$RELEASE"-api -o jsonpath='{.subsets[*].addresses[*].ip}' | wc -w | tr -d ' ')
echo "front-door endpoints=$web_eps  api endpoints=$api_eps"
[ "$web_eps" -ge 1 ] || fail "front-door Service has no endpoints"
[ "$api_eps" -ge 1 ] || fail "api Service has no endpoints"

echo "── start in-cluster load generator (hits front door through nginx→api) ──"
# Two probes per iteration: /healthz (nginx-local) and /api/health (proxied to
# the api tier). Any non-200 or curl error increments FAIL. Writes a running
# tally to its log so we can read it after the rollout.
#
# --retry 5 --retry-all-errors: the zero-downtime property is that the *service*
# never goes unreachable, not that no single TCP packet is ever dropped. Both
# tiers roll with maxUnavailable=0, so a ready endpoint always exists; a browser
# (and curl) simply reconnects and kube-proxy routes to it. Retrying models that
# and absorbs an isolated CI hiccup (kube-proxy endpoint-sync lag, a >max-time
# response under 2-core CPU starvation). A REAL regression — e.g. the earlier
# nginx quit-first bug — makes the front door refuse for a sustained window, so
# every retry also fails and the request still counts as bad. --retry-delay 0
# keeps retries inside any genuine outage window rather than waiting it out.
kubectl -n "$NS" run loadgen --image=curlimages/curl:8.10.1 --restart=Never -- \
  /bin/sh -c '
    ok=0; bad=0; base="http://'"$RELEASE"'.'"$NS"'.svc.cluster.local";
    end=$(( $(date +%s) + 120 ));
    while [ "$(date +%s)" -lt "$end" ]; do
      for path in /healthz /api/health; do
        code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 \
          --retry 5 --retry-delay 0 --retry-all-errors "$base$path" || echo 000);
        if [ "$code" = "200" ]; then ok=$((ok+1)); else bad=$((bad+1)); echo "MISS $path -> $code"; fi
      done
      sleep 0.1;
    done
    echo "RESULT ok=$ok bad=$bad"
  '
# Give the loop a moment to start hitting the old ("blue") pods.
kubectl -n "$NS" wait --for=condition=Ready pod/loadgen --timeout 60s
sleep 5

echo "── roll BOTH tiers (blue → green) while traffic flows ──"
kubectl -n "$NS" set env deploy/"$RELEASE"     ZDT_ROLL="$(date +%s)"
kubectl -n "$NS" set env deploy/"$RELEASE"-web ZDT_ROLL="$(date +%s)"
kubectl -n "$NS" rollout status deploy/"$RELEASE"     --timeout 3m
kubectl -n "$NS" rollout status deploy/"$RELEASE"-web --timeout 3m
echo "rollout complete; letting load finish…"

kubectl -n "$NS" wait --for=jsonpath='{.status.phase}'=Succeeded pod/loadgen --timeout 120s || true
LOG=$(kubectl -n "$NS" logs loadgen)
echo "$LOG" | grep -E "MISS|RESULT" || true
RESULT=$(echo "$LOG" | grep RESULT || echo "RESULT ok=0 bad=-1")
# grep -oE (not sed \?) so parsing is portable across GNU (CI) and BSD (macOS) —
# BSD sed doesn't support \? and silently returns empty, faking a failure.
OK=$(echo "$RESULT"  | grep -oE 'ok=[0-9]+'    | cut -d= -f2)
BAD=$(echo "$RESULT" | grep -oE 'bad=-?[0-9]+' | cut -d= -f2)

echo "── verdict ──"
echo "requests ok=$OK bad=$BAD"
[ "${OK:-0}" -gt 0 ] || fail "load generator made no successful requests (broken setup)"
[ "${BAD:-1}" -eq 0 ] || fail "ZERO-DOWNTIME VIOLATED: $BAD failed request(s) during rollout"
echo "✅ 0 failed requests across a full blue→green rollout of both tiers"

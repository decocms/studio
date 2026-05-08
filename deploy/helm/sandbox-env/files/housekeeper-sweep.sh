#!/bin/sh
# sandbox-housekeeper sweep — one CronJob run.
#
# Env (set by the CronJob spec):
#   NS, TTL_MS, PROBE_TIMEOUT_SEC,
#   CLAIM_SELECTOR, POD_SELECTOR, RUN_ID.

set -eu

: "${NS:?must be set}"
: "${TTL_MS:?must be set}"
: "${PROBE_TIMEOUT_SEC:?must be set}"
: "${CLAIM_SELECTOR:?must be set}"
: "${POD_SELECTOR:?must be set}"
: "${RUN_ID:?must be set}"

DAEMON_PORT=9000
IDLE_PATH="/_decopilot_vm/idle"

now_iso()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_micro() { date -u +%Y-%m-%dT%H:%M:%S.000000Z; }

log() {
  printf '[%s] [housekeeper] run=%s %s\n' "$(now_iso)" "$RUN_ID" "$*"
}

# Best-effort — a misconfigured Event API shouldn't block the reap.
emit_event() {
  claim="$1"; reason="$2"; action="$3"; msg="$4"
  ts=$(now_micro)
  # YAML single-quoted scalar: double any embedded single quotes.
  safe_msg=$(printf '%s' "$msg" | sed "s/'/''/g")
  kubectl create -f - <<YAML >/dev/null 2>&1 || true
apiVersion: events.k8s.io/v1
kind: Event
metadata:
  generateName: ${claim}-housekeeper-
  namespace: ${NS}
eventTime: ${ts}
type: Normal
reason: ${reason}
action: ${action}
note: '${safe_msg}'
reportingController: sandbox-housekeeper
reportingInstance: ${RUN_ID}
regarding:
  apiVersion: extensions.agents.x-k8s.io/v1alpha1
  kind: SandboxClaim
  name: ${claim}
  namespace: ${NS}
YAML
}

# Probe /_decopilot_vm/idle. Echoes one of:
#   <digits>          idleMs (success)
#   __unreachable__   connect/timeout
#   __not_found__     HTTP 404
#   __server_error__  HTTP 5xx
#   __bad_shape__     HTTP 200 but no parseable idleMs
#   __unclaimed__     HTTP 200 but claimed=false (warm-pool pod awaiting first workload)
probe_daemon() {
  ip="$1"
  body=$(mktemp)
  if ! code=$(curl -s -o "$body" \
                --max-time "$PROBE_TIMEOUT_SEC" \
                --retry 1 --retry-all-errors --retry-delay 1 \
                -w '%{http_code}' \
                "http://${ip}:${DAEMON_PORT}${IDLE_PATH}" 2>/dev/null); then
    rm -f "$body"
    echo "__unreachable__"
    return
  fi
  case "$code" in
    2*)
      # Warm-pool pods boot with claimed=false and must not be reaped before
      # mesh delivers a workload via POST /_decopilot_vm/config. Older daemons
      # omit the field; treat absent as claimed=true to preserve existing
      # behaviour on cold-start deployments.
      claimed=$(sed -n 's/.*"claimed"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' "$body")
      if [ "$claimed" = "false" ]; then
        rm -f "$body"
        echo "__unclaimed__"
        return
      fi
      idle=$(sed -n 's/.*"idleMs"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$body")
      rm -f "$body"
      case "$idle" in
        ''|*[!0-9]*) echo "__bad_shape__" ;;
        *)           echo "$idle" ;;
      esac
      ;;
    404) rm -f "$body"; echo "__not_found__" ;;
    5*)  rm -f "$body"; echo "__server_error__" ;;
    *)   rm -f "$body"; echo "__bad_shape__" ;;
  esac
}

# Shared prelude for both reap paths.
mark_for_reap() {
  claim="$1"; reason="$2"; detail="$3"; action="$4"
  kubectl annotate sandboxclaim "$claim" -n "$NS" --overwrite \
    "studio.decocms.com/reap-reason=${reason}" \
    "studio.decocms.com/reap-detail=${detail}" \
    "studio.decocms.com/reap-at=$(now_iso)" \
    "studio.decocms.com/reap-run=${RUN_ID}" >/dev/null 2>&1 || true
  emit_event "$claim" "SandboxReaped" "$action" "housekeeper: $reason ($detail)"
  # Delete HTTPRoute first so traffic stops resolving to the pod before
  # SIGTERM lands — avoids 502s during the drain window.
  kubectl delete httproute -n "$NS" \
    -l "studio.decocms.com/sandbox-handle=${claim}" \
    --ignore-not-found >/dev/null 2>&1 || true
}

# Graceful path: operator drains the pod via shutdownTime. Used for Idle
# where the operator is still functional.
request_shutdown() {
  claim="$1"; reason="$2"; detail="$3"
  log "shutdown claim=$claim reason=$reason detail=\"$detail\""
  mark_for_reap "$claim" "$reason" "$detail" "Shutdown"
  ts=$(now_iso)
  kubectl patch sandboxclaim "$claim" -n "$NS" --type=merge \
    -p "{\"spec\":{\"lifecycle\":{\"shutdownPolicy\":\"Delete\",\"shutdownTime\":\"${ts}\"}}}" \
    >/dev/null 2>&1 || true
}

# ReconcilerError path: operator has given up, so shutdownTime is unhonored.
force_delete_claim() {
  claim="$1"; reason="$2"; detail="$3"
  log "delete claim=$claim reason=$reason detail=\"$detail\""
  mark_for_reap "$claim" "$reason" "$detail" "Delete"
  kubectl delete sandboxclaim "$claim" -n "$NS" \
    --ignore-not-found >/dev/null 2>&1 || true
}

# === main ===
log "starting (ttl=${TTL_MS}ms probe_timeout=${PROBE_TIMEOUT_SEC}s)"

CLAIMS_FILE=$(mktemp)
PODS_FILE=$(mktemp)
ROUTES_FILE=$(mktemp)
trap 'rm -f "$CLAIMS_FILE" "$PODS_FILE" "$ROUTES_FILE"' EXIT

# Pipe-delimited so `read` can split without jq.
kubectl get sandboxclaims -n "$NS" -l "$CLAIM_SELECTOR" \
  -o jsonpath='{range .items[*]}{.metadata.name}|{.status.conditions[?(@.type=="Ready")].status}|{.status.conditions[?(@.type=="Ready")].reason}{"\n"}{end}' \
  > "$CLAIMS_FILE" 2>/dev/null || true

# Selector-mismatch detector: silent `claims=0` hides a missing STUDIO_ENV
# on mesh. Warn loudly and gate orphan GC off so we don't nuke routes whose
# claims are present but unlabeled.
selector_mismatch=0
if ! [ -s "$CLAIMS_FILE" ]; then
  unscoped=$(kubectl get sandboxclaims -n "$NS" \
    -l "app.kubernetes.io/managed-by=studio,app.kubernetes.io/name=studio-sandbox" \
    -o name 2>/dev/null | wc -l | tr -d ' ' || echo 0)
  if [ "${unscoped:-0}" -gt 0 ]; then
    log "WARN selector matched zero claims but ${unscoped} studio-managed claim(s) exist in ${NS} — verify STUDIO_ENV is set on the mesh deployment and matches the chart's envName (current selector: ${CLAIM_SELECTOR})"
    selector_mismatch=1
  fi
fi

kubectl get pods -n "$NS" -l "$POD_SELECTOR" \
  -o jsonpath='{range .items[*]}{.metadata.labels.studio\.decocms\.com/sandbox-handle}|{.status.podIP}{"\n"}{end}' \
  > "$PODS_FILE" 2>/dev/null || true

total=0
reaped=0
skipped=0

# Redirect (not pipe) so the loop stays in the parent shell — pipe-into-
# while subshells the body and counter mutations would be lost.
while IFS='|' read -r CLAIM READY REASON; do
  [ -z "$CLAIM" ] && continue
  total=$((total + 1))

  if [ "$READY" = "False" ] && [ "$REASON" = "ReconcilerError" ]; then
    force_delete_claim "$CLAIM" "ReconcilerError" "operator failed to reconcile"
    reaped=$((reaped + 1))
    continue
  fi

  if [ "$READY" != "True" ]; then
    log "skip claim=$CLAIM reason=not-ready ready=${READY:-<none>} status_reason=${REASON:-<none>}"
    skipped=$((skipped + 1))
    continue
  fi

  POD_IP=$(awk -F'|' -v h="$CLAIM" '$1==h && $2!="" { print $2; exit }' "$PODS_FILE")
  if [ -z "$POD_IP" ]; then
    log "skip claim=$CLAIM reason=no-pod-ip"
    skipped=$((skipped + 1))
    continue
  fi

  RESULT=$(probe_daemon "$POD_IP")
  case "$RESULT" in
    __unclaimed__)
      log "skip claim=$CLAIM reason=unclaimed (warm-pool pod awaiting first workload)"
      skipped=$((skipped + 1))
      ;;
    __unreachable__|__not_found__|__server_error__|__bad_shape__)
      log "skip claim=$CLAIM reason=probe-failed detail=$RESULT"
      skipped=$((skipped + 1))
      ;;
    *)
      IDLE_MS="$RESULT"
      if [ "$IDLE_MS" -lt "$TTL_MS" ]; then
        log "keep claim=$CLAIM idle_ms=$IDLE_MS remaining_ms=$((TTL_MS - IDLE_MS))"
        continue
      fi
      # Re-probe right before reap to narrow (not eliminate) the
      # activity-during-decide race. An in-flight request arriving after
      # this second probe still gets connection-reset.
      RESULT2=$(probe_daemon "$POD_IP")
      case "$RESULT2" in
        __*)
          log "abort-reap claim=$CLAIM reason=re-probe-failed first_idle_ms=$IDLE_MS detail=$RESULT2"
          skipped=$((skipped + 1))
          ;;
        *)
          if [ "$RESULT2" -lt "$TTL_MS" ]; then
            log "abort-reap claim=$CLAIM reason=activity-during-decide first_idle_ms=$IDLE_MS reprobe_idle_ms=$RESULT2"
            skipped=$((skipped + 1))
          else
            request_shutdown "$CLAIM" "Idle" "idle_ms=$IDLE_MS reprobe_idle_ms=$RESULT2 ttl_ms=$TTL_MS"
            reaped=$((reaped + 1))
          fi
          ;;
      esac
      ;;
  esac
done < "$CLAIMS_FILE"

# === orphan HTTPRoute GC ===
# Catches routes whose runner stop() failed to delete. Skipped on selector
# mismatch to avoid nuking routes whose claims are present but unlabeled.
orphan_routes=0
if [ "$selector_mismatch" -eq 0 ]; then
  kubectl get httproutes -n "$NS" -l "$CLAIM_SELECTOR" \
    -o jsonpath='{range .items[*]}{.metadata.name}|{.metadata.labels.studio\.decocms\.com/sandbox-handle}{"\n"}{end}' \
    > "$ROUTES_FILE" 2>/dev/null || true

  while IFS='|' read -r ROUTE_NAME ROUTE_HANDLE; do
    [ -z "$ROUTE_NAME" ] && continue
    [ -z "$ROUTE_HANDLE" ] && continue
    # Live-claim membership test against col 1 of CLAIMS_FILE.
    # `exit` from a main-block jumps to END, whose own `exit` overrides the
    # status — so `{ exit 0 } END { exit 1 }` always returns 1 and every
    # route gets nuked. Track via a flag and let END be authoritative.
    if awk -F'|' -v h="$ROUTE_HANDLE" \
         '$1==h { found=1; exit } END { exit !found }' \
         "$CLAIMS_FILE"; then
      continue
    fi
    log "orphan-route-gc route=$ROUTE_NAME handle=$ROUTE_HANDLE"
    kubectl delete httproute "$ROUTE_NAME" -n "$NS" \
      --ignore-not-found >/dev/null 2>&1 || true
    orphan_routes=$((orphan_routes + 1))
  done < "$ROUTES_FILE"
fi

log "heartbeat ok claims=$total reaped=$reaped skipped=$skipped orphan_routes=$orphan_routes"

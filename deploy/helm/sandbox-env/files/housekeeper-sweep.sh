#!/bin/sh
# sandbox-housekeeper sweep — one CronJob run.
#
# Env (set by the CronJob spec):
#   NS, TTL_MS, PROBE_TIMEOUT_SEC, RENEW_ACTIVE_MS,
#   CLAIM_SELECTOR, POD_SELECTOR, RUN_ID.

set -eu

: "${NS:?must be set}"
: "${TTL_MS:?must be set}"
: "${PROBE_TIMEOUT_SEC:?must be set}"
: "${CLAIM_SELECTOR:?must be set}"
: "${POD_SELECTOR:?must be set}"
: "${RUN_ID:?must be set}"

DAEMON_PORT=9000
# Canonical path served by the daemon after T11; old daemons that haven't
# auto-updated still serve the legacy path. Probe the new one first and
# fall back if the daemon returns 404 (unknown route). Remove the legacy
# probe once all sandboxes have rotated to the post-rename daemon image.
IDLE_PATH="/_sandbox/idle"
LEGACY_IDLE_PATH="/_decopilot_vm/idle"

# A transient optimistic-concurrency conflict on the SandboxClaim status write
# surfaces as Ready=False/reason=ReconcilerError for ~1s before the operator
# retries and recovers (a concurrent reconcile still lands status.sandbox.name).
# Don't force-delete on first sight — require the error to persist this long, so
# we never delete a freshly-adopted claim out from under a client still inside
# its adoption wait (the "did not record an adopted Sandbox within 60s" freeze).
# Override via the CronJob env if needed.
: "${RECONCILER_ERROR_GRACE_SEC:=120}"

# A claim's own deadline (`spec.lifecycle.shutdownTime`, 15 min) is pushed
# forward ONLY by Studio — the preview SSE handler or a streaming run. Someone
# who opens the preview URL straight in a browser, which is how these links get
# shared, renews nothing: the pod is deleted under them mid-session and the
# hostname 502s until they reopen it from Studio. The daemon counts every
# proxied request as activity, so a small idleMs here is the live-viewer signal
# Studio cannot see, and this is the only sweep that sees it.
#
# Deliberately much shorter than TTL_MS: a claim Studio released early on
# purpose (`releaseAfter` after a headless run) goes idle the moment the run
# ends, so it still dies on its grace deadline. Only traffic in the last couple
# of minutes — a human actually looking at the page — buys more time.
: "${RENEW_ACTIVE_MS:=120000}"
RECONCILER_ERROR_SINCE_ANNOTATION="studio.decocms.com/reconciler-error-since"

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

# Probe /_sandbox/idle (falling back to the legacy /_decopilot_vm/idle for
# old daemons). Echoes one of:
#   <digits>          idleMs (success)
#   __unreachable__   connect/timeout
#   __not_found__     HTTP 404
#   __server_error__  HTTP 5xx
#   __bad_shape__     HTTP 200 but no parseable idleMs
#   __unclaimed__     HTTP 200 but claimed=false (warm-pool pod awaiting first workload)
probe_daemon_at() {
  ip="$1"; path="$2"; body="$3"
  curl -s -o "$body" \
       --max-time "$PROBE_TIMEOUT_SEC" \
       --retry 1 --retry-all-errors --retry-delay 1 \
       -w '%{http_code}' \
       "http://${ip}:${DAEMON_PORT}${path}" 2>/dev/null
}

probe_daemon() {
  ip="$1"
  body=$(mktemp)
  # Try canonical path; if the daemon returns 404 (unknown route), the pod
  # is running a pre-T11 daemon image — fall through to the legacy path.
  # Any other status (success, 5xx, transport failure) is authoritative on
  # the canonical attempt and short-circuits without a legacy probe.
  if ! code=$(probe_daemon_at "$ip" "$IDLE_PATH" "$body"); then
    if ! code=$(probe_daemon_at "$ip" "$LEGACY_IDLE_PATH" "$body"); then
      rm -f "$body"
      echo "__unreachable__"
      return
    fi
  elif [ "$code" = "404" ]; then
    if ! code=$(probe_daemon_at "$ip" "$LEGACY_IDLE_PATH" "$body"); then
      rm -f "$body"
      echo "__unreachable__"
      return
    fi
  fi
  case "$code" in
    2*)
      # Warm-pool pods boot with claimed=false and must not be reaped before
      # Studio delivers a workload via POST /_sandbox/config. Older daemons
      # omit the field; treat absent as claimed=true to preserve existing
      # behaviour on cold-start deployments.
      # `[a-z][a-z]*` rather than `\(true\|false\)`: alternation is a GNU BRE
      # extension, and where it isn't supported the capture silently yields
      # nothing — which reads as "claimed" and reaps a warm pod.
      claimed=$(sed -n 's/.*"claimed"[[:space:]]*:[[:space:]]*\([a-z][a-z]*\).*/\1/p' "$body")
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

# Epoch seconds → `YYYY-MM-DDTHH:MM:SSZ`. `date -u -d @<epoch>` would be one
# line, but it's a GNU extension and this sweep runs on busybox — where the
# failure would be a silently empty timestamp, i.e. renewals that never happen
# and nobody notices. awk is on both. (civil-from-days; valid for epoch >= 0.)
iso_from_epoch() {
  awk -v t="$1" 'BEGIN {
    days = int(t / 86400); secs = t % 86400
    z = days + 719468
    era = int(z / 146097)
    doe = z - era * 146097
    yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
    y = yoe + era * 400
    doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
    mp = int((5 * doy + 2) / 153)
    d = doy - int((153 * mp + 2) / 5) + 1
    m = mp + (mp < 10 ? 3 : -9)
    if (m <= 2) y = y + 1
    printf "%04d-%02d-%02dT%02d:%02d:%02dZ", y, m, d, int(secs / 3600), int((secs % 3600) / 60), secs % 60
  }'
}

# Push a claim's deadline out to now + TTL because its daemon just served
# traffic. Best-effort: a missed renewal costs one reprovision, and the next
# sweep is a minute away.
renew_shutdown() {
  claim="$1"; idle="$2"
  ts=$(iso_from_epoch "$(( $(date -u +%s) + TTL_MS / 1000 ))")
  case "$ts" in
    ????-??-??T??:??:??Z) ;;
    *) log "renew-skip claim=$claim reason=bad-timestamp value=\"$ts\""; return 0 ;;
  esac
  log "renew claim=$claim idle_ms=$idle shutdown_at=$ts"
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

# Sourced by housekeeper-sweep.test.ts to exercise probe_daemon against a real
# HTTP server. Everything above is pure shell + curl; everything below needs a
# cluster. Without this the `claimed=false` branch — the one thing keeping the
# sweep off tenant warm-pool pods — has no test at all.
[ "${HOUSEKEEPER_SOURCE_ONLY:-}" = "1" ] && return 0

# === main ===
log "starting (ttl=${TTL_MS}ms renew_active=${RENEW_ACTIVE_MS}ms probe_timeout=${PROBE_TIMEOUT_SEC}s)"

CLAIMS_FILE=$(mktemp)
PODS_FILE=$(mktemp)
ROUTES_FILE=$(mktemp)
trap 'rm -f "$CLAIMS_FILE" "$PODS_FILE" "$ROUTES_FILE"' EXIT

# Pipe-delimited so `read` can split without jq. Trailing field:
#   reconciler-error-since — our epoch stamp tracking a ReconcilerError streak
kubectl get sandboxclaims -n "$NS" -l "$CLAIM_SELECTOR" \
  -o jsonpath='{range .items[*]}{.metadata.name}|{.status.conditions[?(@.type=="Ready")].status}|{.status.conditions[?(@.type=="Ready")].reason}|{.metadata.annotations.studio\.decocms\.com/reconciler-error-since}{"\n"}{end}' \
  > "$CLAIMS_FILE" 2>/dev/null || true

# Selector-mismatch detector: silent `claims=0` hides a missing STUDIO_ENV
# on Studio. Warn loudly and gate orphan GC off so we don't nuke routes whose
# claims are present but unlabeled.
selector_mismatch=0
if ! [ -s "$CLAIMS_FILE" ]; then
  unscoped=$(kubectl get sandboxclaims -n "$NS" \
    -l "app.kubernetes.io/managed-by=studio,app.kubernetes.io/name=studio-sandbox" \
    -o name 2>/dev/null | wc -l | tr -d ' ' || echo 0)
  if [ "${unscoped:-0}" -gt 0 ]; then
    log "WARN selector matched zero claims but ${unscoped} studio-managed claim(s) exist in ${NS} — verify STUDIO_ENV is set on the Studio deployment and matches the chart's envName (current selector: ${CLAIM_SELECTOR})"
    selector_mismatch=1
  fi
fi

kubectl get pods -n "$NS" -l "$POD_SELECTOR" \
  -o jsonpath='{range .items[*]}{.metadata.labels.studio\.decocms\.com/sandbox-handle}|{.status.podIP}{"\n"}{end}' \
  > "$PODS_FILE" 2>/dev/null || true

total=0
reaped=0
renewed=0
skipped=0

# Redirect (not pipe) so the loop stays in the parent shell — pipe-into-
# while subshells the body and counter mutations would be lost.
while IFS='|' read -r CLAIM READY REASON ERROR_SINCE; do
  [ -z "$CLAIM" ] && continue
  total=$((total + 1))

  if [ "$READY" = "False" ] && [ "$REASON" = "ReconcilerError" ]; then
    now_s=$(date -u +%s)
    # Treat an absent/garbage stamp as "first seen": start the grace clock and
    # wait. A transient conflict clears well before the next 60s sweep.
    case "$ERROR_SINCE" in
      ''|*[!0-9]*)
        kubectl annotate sandboxclaim "$CLAIM" -n "$NS" --overwrite \
          "${RECONCILER_ERROR_SINCE_ANNOTATION}=${now_s}" >/dev/null 2>&1 || true
        log "defer-delete claim=$CLAIM reason=ReconcilerError (first seen, grace ${RECONCILER_ERROR_GRACE_SEC}s)"
        skipped=$((skipped + 1))
        continue
        ;;
    esac
    age_s=$((now_s - ERROR_SINCE))
    if [ "$age_s" -lt "$RECONCILER_ERROR_GRACE_SEC" ]; then
      log "defer-delete claim=$CLAIM reason=ReconcilerError age_s=$age_s grace_s=$RECONCILER_ERROR_GRACE_SEC"
      skipped=$((skipped + 1))
      continue
    fi
    # Error has persisted past the grace window — the operator really is stuck.
    force_delete_claim "$CLAIM" "ReconcilerError" "persisted ${age_s}s past ${RECONCILER_ERROR_GRACE_SEC}s grace"
    reaped=$((reaped + 1))
    continue
  fi

  # Not in ReconcilerError this sweep — clear any stale streak stamp so a future
  # transient error starts its grace window fresh (else a later blip would be
  # judged against a long-expired timestamp and deleted immediately).
  if [ -n "$ERROR_SINCE" ]; then
    kubectl annotate sandboxclaim "$CLAIM" -n "$NS" \
      "${RECONCILER_ERROR_SINCE_ANNOTATION}-" >/dev/null 2>&1 || true
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
        if [ "$IDLE_MS" -lt "$RENEW_ACTIVE_MS" ]; then
          renew_shutdown "$CLAIM" "$IDLE_MS"
          renewed=$((renewed + 1))
        fi
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
            # Sparing it from the sweep isn't enough: its own deadline is what
            # was about to fire, and it's now imminent.
            if [ "$RESULT2" -lt "$RENEW_ACTIVE_MS" ]; then
              renew_shutdown "$CLAIM" "$RESULT2"
              renewed=$((renewed + 1))
            fi
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

# === Failed pod GC ===
# A sandbox pod whose orgfs-sidecar can't unmount within terminationGracePeriod
# is SIGKILLed (exit 137), flipping the whole pod to phase=Failed. Its owner
# Sandbox is already gone by then, so nothing garbage-collects it and Failed
# pods pile up for hours. Reap them here — Failed is terminal, so a delete can't
# race a live workload. Gated on selector_mismatch (same caution as routes).
failed_pods=0
if [ "$selector_mismatch" -eq 0 ]; then
  for POD in $(kubectl get pods -n "$NS" -l "$POD_SELECTOR" \
      --field-selector=status.phase=Failed \
      -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null); do
    [ -z "$POD" ] && continue
    log "failed-pod-gc pod=$POD"
    kubectl delete pod "$POD" -n "$NS" --ignore-not-found >/dev/null 2>&1 || true
    failed_pods=$((failed_pods + 1))
  done
fi

log "heartbeat ok claims=$total reaped=$reaped renewed=$renewed skipped=$skipped orphan_routes=$orphan_routes failed_pods=$failed_pods"

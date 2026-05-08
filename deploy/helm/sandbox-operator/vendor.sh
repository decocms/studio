#!/usr/bin/env bash
# Re-vendor kubernetes-sigs/agent-sandbox release assets into this subchart.
#
# Upstream ships raw multi-doc YAML (manifest.yaml + extensions.yaml), not a
# Helm chart. We split by kind: CustomResourceDefinition docs land in crds/,
# everything else in templates/ so Helm treats CRDs with its install-only
# lifecycle (see README.md for the upgrade caveat).
#
# Integrity: every supported upstream version is paired with a sha256 in
# KNOWN_CHECKSUMS below. The script refuses to write outputs unless every
# downloaded asset matches its pinned digest — this is the only line of
# defense against a swapped GitHub release asset (compromised maintainer
# account, credential theft, etc.). To bump:
#   1. Run: ./vendor.sh vX.Y.Z   — it will fail with "no pinned checksum"
#   2. Compute sha256: shasum -a 256 manifest.yaml extensions.yaml
#   3. Verify the values out-of-band (release notes, signatures if any).
#   4. Add the entry to KNOWN_CHECKSUMS, commit, re-run.
#
# Usage: ./vendor.sh [vX.Y.Z]   (default v0.4.2 — must match appVersion)
set -euo pipefail

UPSTREAM_VERSION="${1:-v0.4.2}"
REPO="kubernetes-sigs/agent-sandbox"

# Pinned sha256 digests for `${VERSION}:${ASSET}`. Keep entries sorted by
# version. Verify externally before adding a new row — anything past this
# table is implicitly trusted.
declare -A KNOWN_CHECKSUMS=(
  ["v0.4.2:manifest.yaml"]="93cb43a90b9093c84a7529a7dbeca409fcd944746df00b52e8a2781c237c6e18"
  ["v0.4.2:extensions.yaml"]="6ddcd6ce2d78714a5815d4c4304df858a075e0ed8fee971966b31af548c011bb"
)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRDS_FILE="${SCRIPT_DIR}/crds/agent-sandbox-crds.yaml"
TMPL_FILE="${SCRIPT_DIR}/templates/agent-sandbox-manifest.yaml"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

log() { printf "\033[1;34m[vendor]\033[0m %s\n" "$*"; }
err() { printf "\033[1;31m[vendor]\033[0m %s\n" "$*" >&2; }

# Refuse to overwrite locally-modified outputs without warning. The vendor
# script regenerates files in-place; an in-progress local edit would be
# silently obliterated.
if ! git -C "${SCRIPT_DIR}" diff --quiet -- crds templates 2>/dev/null \
   || ! git -C "${SCRIPT_DIR}" diff --cached --quiet -- crds templates 2>/dev/null; then
  err "uncommitted changes under crds/ or templates/ — commit or stash before re-vendoring"
  exit 1
fi

verify_checksum() {
  local file="$1" expected="$2" actual
  actual="$(shasum -a 256 "${file}" | awk '{print $1}')"
  if [ "${actual}" != "${expected}" ]; then
    err "checksum mismatch for $(basename "${file}")"
    err "  expected: ${expected}"
    err "  actual:   ${actual}"
    err "  the upstream release asset has changed since this checksum was pinned;"
    err "  verify the new digest out-of-band before updating KNOWN_CHECKSUMS"
    exit 1
  fi
}

require_checksum() {
  local key="$1"
  if [ -z "${KNOWN_CHECKSUMS[$key]:-}" ]; then
    err "no pinned checksum for ${key}"
    err "  to bump: download the asset manually, compute shasum -a 256, verify"
    err "  against upstream release notes, then add a row to KNOWN_CHECKSUMS"
    exit 1
  fi
  printf "%s" "${KNOWN_CHECKSUMS[$key]}"
}

log "fetching ${REPO}@${UPSTREAM_VERSION}"
MANIFEST_SHA="$(require_checksum "${UPSTREAM_VERSION}:manifest.yaml")"
EXTENSIONS_SHA="$(require_checksum "${UPSTREAM_VERSION}:extensions.yaml")"

curl -fsSLo "${WORK}/manifest.yaml" \
  "https://github.com/${REPO}/releases/download/${UPSTREAM_VERSION}/manifest.yaml"
curl -fsSLo "${WORK}/extensions.yaml" \
  "https://github.com/${REPO}/releases/download/${UPSTREAM_VERSION}/extensions.yaml"

verify_checksum "${WORK}/manifest.yaml"   "${MANIFEST_SHA}"
verify_checksum "${WORK}/extensions.yaml" "${EXTENSIONS_SHA}"
log "checksums verified"

# Merge the two upstream files' controller Deployments into one.
#
# Upstream ships manifest.yaml + extensions.yaml as two install paths:
# manifest.yaml alone for base mode (Sandbox reconciler only), or both
# files applied in order, where extensions.yaml's Deployment overwrites
# manifest.yaml's same-named Deployment to add `--extensions` and pull in
# the SandboxClaim / SandboxTemplate / SandboxWarmPool reconcilers.
# Concatenating them into one chart breaks that override: helm/kubectl
# applies one of the duplicates and the other silently disappears, so
# only one controller mode actually runs. The leader-election lock is
# hardcoded in the binary (no flag to override the lock name), so running
# them as two distinct Deployments doesn't work either — only one would
# ever be the leader. Running a single binary with `--extensions=true`
# enables ALL reconcilers in one process, which is what we want.
#
# Two transformations, both fail-loud if the input shape changes:
#   1. Drop the `kind: Deployment` doc from extensions.yaml — keep its
#      ClusterRole / ClusterRoleBinding (those are the extensions RBAC).
#   2. Insert `- --extensions` after `- --leader-elect=true` in manifest.yaml's
#      Deployment args.
#
# Done after checksum verification on purpose: the checksum proves what
# upstream shipped; this transformation is an intentional downstream patch.
log "dropping duplicate Deployment from extensions.yaml"
awk '
  function flush(   i, is_dep) {
    if (n == 0) return
    is_dep = 0
    for (i = 1; i <= n; i++) {
      if (buf[i] ~ /^kind:[[:space:]]*Deployment[[:space:]]*$/) { is_dep = 1; break }
    }
    if (!is_dep) {
      for (i = 1; i <= n; i++) print buf[i]
      print "---"
    }
    n = 0
  }
  /^---[[:space:]]*$/ { flush(); next }
  { buf[++n] = $0 }
  END { flush() }
' "${WORK}/extensions.yaml" > "${WORK}/extensions.patched.yaml"
sed -i.bak -e '$d' "${WORK}/extensions.patched.yaml" && rm "${WORK}/extensions.patched.yaml.bak"
mv "${WORK}/extensions.patched.yaml" "${WORK}/extensions.yaml"
if grep -q '^kind:[[:space:]]*Deployment' "${WORK}/extensions.yaml"; then
  err "post-patch: a Deployment doc still exists in extensions.yaml"
  err "  inspect ${WORK}/extensions.yaml and update the awk patch in this script"
  exit 1
fi

log "adding --extensions to manifest.yaml Deployment args"
awk '
  function flush(   i, is_dep, indent) {
    if (n == 0) return
    is_dep = 0
    for (i = 1; i <= n; i++) {
      if (buf[i] ~ /^kind:[[:space:]]*Deployment[[:space:]]*$/) { is_dep = 1; break }
    }
    for (i = 1; i <= n; i++) {
      print buf[i]
      if (is_dep && buf[i] ~ /^[[:space:]]*-[[:space:]]*"?--leader-elect=true"?[[:space:]]*$/) {
        match(buf[i], /^[[:space:]]*/)
        indent = substr(buf[i], RSTART, RLENGTH)
        print indent "- --extensions"
      }
    }
    print "---"
    n = 0
  }
  /^---[[:space:]]*$/ { flush(); next }
  { buf[++n] = $0 }
  END { flush() }
' "${WORK}/manifest.yaml" > "${WORK}/manifest.patched.yaml"
sed -i.bak -e '$d' "${WORK}/manifest.patched.yaml" && rm "${WORK}/manifest.patched.yaml.bak"
mv "${WORK}/manifest.patched.yaml" "${WORK}/manifest.yaml"
if ! grep -q '^[[:space:]]*-[[:space:]]*--extensions[[:space:]]*$' "${WORK}/manifest.yaml"; then
  err "post-patch: --extensions arg was not added to manifest.yaml Deployment"
  err "  inspect ${WORK}/manifest.yaml and update the awk patch in this script"
  exit 1
fi

# Inject PodSecurity admission labels into the agent-sandbox-system Namespace.
#
# Upstream ships a bare Namespace; we enforce `baseline` and warn/audit on
# `restricted` so violations from sandbox pods or the controller surface in
# audit logs without rejecting admission. When the operator's pod spec
# hardens to restricted, flip enforce. See README + the LOCAL EDIT comment
# in HEADER_TMPL below.
log "injecting PodSecurity admission labels into agent-sandbox-system Namespace"
awk '
  function flush(   i, is_target, has_kind, name_line, indent) {
    if (n == 0) return
    is_target = 0
    has_kind = 0
    name_line = 0
    for (i = 1; i <= n; i++) {
      if (buf[i] ~ /^kind:[[:space:]]*Namespace[[:space:]]*$/) has_kind = 1
      if (has_kind && buf[i] ~ /^[[:space:]]+name:[[:space:]]*agent-sandbox-system[[:space:]]*$/) {
        is_target = 1
        name_line = i
        break
      }
    }
    if (!is_target) {
      for (i = 1; i <= n; i++) print buf[i]
      print "---"
      n = 0
      return
    }
    for (i = 1; i <= n; i++) {
      print buf[i]
      if (i == name_line) {
        match(buf[i], /^[[:space:]]*/)
        indent = substr(buf[i], RSTART, RLENGTH)
        print indent "labels:"
        print indent "  pod-security.kubernetes.io/enforce: baseline"
        print indent "  pod-security.kubernetes.io/enforce-version: latest"
        print indent "  pod-security.kubernetes.io/warn: restricted"
        print indent "  pod-security.kubernetes.io/warn-version: latest"
        print indent "  pod-security.kubernetes.io/audit: restricted"
        print indent "  pod-security.kubernetes.io/audit-version: latest"
      }
    }
    print "---"
    n = 0
  }
  /^---[[:space:]]*$/ { flush(); next }
  { buf[++n] = $0 }
  END { flush() }
' "${WORK}/manifest.yaml" > "${WORK}/manifest.patched.yaml"
sed -i.bak -e '$d' "${WORK}/manifest.patched.yaml" && rm "${WORK}/manifest.patched.yaml.bak"
mv "${WORK}/manifest.patched.yaml" "${WORK}/manifest.yaml"
if ! grep -q '^[[:space:]]*pod-security.kubernetes.io/enforce:[[:space:]]*baseline[[:space:]]*$' "${WORK}/manifest.yaml"; then
  err "post-patch: PodSecurity labels were not injected into the Namespace doc"
  err "  upstream may have moved the Namespace into extensions.yaml or changed its name;"
  err "  inspect ${WORK}/manifest.yaml and update the awk patch in this script"
  exit 1
fi
# If upstream ever adds its own labels: block, our awk would produce a
# duplicate `labels:` key and helm lint would fail. That's the canary —
# fix the awk to merge into the existing labels block when it happens.

# Split each multi-doc YAML by `---` boundaries, classify each doc by kind.
# awk is portable (no yq dependency) and good enough for manifests that only
# need a kind: line scanned.
split_docs() {
  local src="$1" crds_out="$2" other_out="$3"
  awk -v crds="${crds_out}" -v other="${other_out}" '
    function flush(   isCrd, i, out) {
      if (n == 0) return
      isCrd = 0
      for (i = 1; i <= n; i++) {
        if (buf[i] ~ /^kind:[[:space:]]*CustomResourceDefinition[[:space:]]*$/) {
          isCrd = 1
          break
        }
      }
      out = isCrd ? crds : other
      for (i = 1; i <= n; i++) print buf[i] >> out
      print "---" >> out
      n = 0
    }
    /^---[[:space:]]*$/ { flush(); next }
    { buf[++n] = $0 }
    END { flush() }
  ' "${src}"
}

log "splitting CRDs from non-CRDs"
: > "${WORK}/crds.yaml"
: > "${WORK}/other.yaml"
split_docs "${WORK}/manifest.yaml"   "${WORK}/crds.yaml" "${WORK}/other.yaml"
split_docs "${WORK}/extensions.yaml" "${WORK}/crds.yaml" "${WORK}/other.yaml"

# Strip trailing empty doc separator so `helm template` doesn't warn.
sed -i.bak -e '$d' "${WORK}/crds.yaml"  && rm "${WORK}/crds.yaml.bak"
sed -i.bak -e '$d' "${WORK}/other.yaml" && rm "${WORK}/other.yaml.bak"

mkdir -p "$(dirname "${CRDS_FILE}")" "$(dirname "${TMPL_FILE}")"

HEADER_CRDS="# Vendored from ${REPO} ${UPSTREAM_VERSION} via vendor.sh.
# Do not edit by hand — re-run vendor.sh to refresh.
# Contains: CustomResourceDefinition docs only.
"

HEADER_TMPL="# Vendored from ${REPO} ${UPSTREAM_VERSION} via vendor.sh.
# Do not edit by hand — re-run vendor.sh to refresh.
# Contains: controller Deployments, RBAC, Namespace, Service, ServiceAccount.
#
# LOCAL EDIT — preserve when re-running vendor.sh:
#   PodSecurity admission labels added to the Namespace below. \`baseline\`
#   is enforced (operator controller pod runs without an explicit
#   securityContext; \`restricted\` would block it until that's patched).
#   \`restricted\` is set as warn/audit so violations from sandbox pods or
#   the controller surface in audit logs without rejecting admission.
#   When the operator's pod spec hardens to \`restricted\`, flip enforce.
"

printf "%s" "${HEADER_CRDS}" > "${CRDS_FILE}"
cat "${WORK}/crds.yaml" >> "${CRDS_FILE}"

printf "%s" "${HEADER_TMPL}" > "${TMPL_FILE}"
cat "${WORK}/other.yaml" >> "${TMPL_FILE}"

log "wrote $(wc -l <"${CRDS_FILE}") lines -> ${CRDS_FILE}"
log "wrote $(wc -l <"${TMPL_FILE}") lines -> ${TMPL_FILE}"
log "done. Remember to:"
log "  - update appVersion in Chart.yaml if the version changed"
log "  - bump KNOWN_CHECKSUMS in this script when bumping ${UPSTREAM_VERSION}"
log "  - bump version in Chart.yaml so .github/workflows/release-sandbox-charts.yaml"
log "    publishes a new OCI artifact"
log "  - DO NOT track sandbox-operator-*.tgz in git (it's gitignored — the"
log "    unpacked tree is the source of truth; the published ghcr.io OCI"
log "    artifact is the consumer-facing build)"

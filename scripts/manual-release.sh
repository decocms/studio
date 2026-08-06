#!/usr/bin/env bash
# Manual fallback for the release pipeline when GitHub Actions is down.
# Replicates, locally:
#   1. (optional) release-tagging.yaml  — [release]: version-bump commit on main
#   2. release-studio.yaml             — build tarball, build+push both multi-arch
#                                        images to GHCR (idempotent per artifact)
#   3. deco-apps-cd bump-studio-image  — commit the tag bump to stg + prod values
#
# ArgoCD watches deco-apps-cd directly, so after this runs: stg rolls out
# automatically; prod needs a manual Sync in ArgoCD (promotion gate preserved).
#
# Usage:
#   scripts/manual-release.sh                 # release apps/api/package.json version as-is
#   scripts/manual-release.sh --bump patch    # bump (patch|minor|major) + commit to main first
#   scripts/manual-release.sh --npm           # also `npm publish` the tarball (needs npm login)
#   scripts/manual-release.sh --amd64-only    # skip arm64 leg (faster; only if nodes are amd64)
#   scripts/manual-release.sh --skip-cd       # don't touch deco-apps-cd
#
# Needs: docker (buildx), bun, node/npm, gh (authed), jq, perl.
# GHCR push auth: tries your `gh` token; if the push 403s, do
#   docker login ghcr.io  # with a PAT that has write:packages
# and re-run (already-pushed artifacts are skipped).
set -euo pipefail

REGISTRY=ghcr.io
API_IMAGE=$REGISTRY/decocms/studio/studio
NGINX_IMAGE=$REGISTRY/decocms/studio/studio-nginx
CD_REPO=decocms/deco-apps-cd
PLATFORMS=linux/amd64,linux/arm64
BUMP="" DO_NPM=false SKIP_CD=false

while [ $# -gt 0 ]; do
  case "$1" in
    --bump) BUMP="$2"; shift 2 ;;
    --npm) DO_NPM=true; shift ;;
    --amd64-only) PLATFORMS=linux/amd64; shift ;;
    --skip-cd) SKIP_CD=true; shift ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ---------- preflight ----------
for bin in docker bun npm gh jq perl; do
  command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 1; }
done
gh auth status >/dev/null || { echo "gh not authenticated" >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "working tree not clean" >&2; exit 1; }
BRANCH="$(git branch --show-current)"
[ "$BRANCH" = main ] || echo "WARNING: releasing from branch '$BRANCH', not main"
git fetch origin main --quiet

# ---------- 1. optional version bump ([release]: commit on main) ----------
if [ -n "$BUMP" ]; then
  case "$BUMP" in patch|minor|major) ;; *) echo "--bump must be patch|minor|major" >&2; exit 1 ;; esac
  [ "$BRANCH" = main ] || { echo "--bump requires being on main" >&2; exit 1; }
  git pull --rebase origin main --quiet
  NEW=$(node -e '
    const fs = require("fs");
    const p = "apps/api/package.json";
    const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
    const [ma, mi, pa] = pkg.version.split(".").map(Number);
    const bump = process.argv[1];
    pkg.version = bump === "major" ? `${ma + 1}.0.0` : bump === "minor" ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
    console.log(pkg.version);
  ' "$BUMP")
  git add apps/api/package.json
  # [release]: prefix keeps release-tagging from re-bumping this commit when
  # Actions comes back; Deploy-Scope mirrors the trailer release-studio reads.
  git commit -qm "[release]: bump to ${NEW} (manual, Actions outage)

Deploy-Scope: both"
  for i in 1 2 3; do
    git push origin HEAD:main && break
    [ "$i" = 3 ] && { echo "push to main rejected 3x (branch protection?)" >&2; exit 1; }
    git fetch origin main && git rebase origin/main
  done
fi

VERSION=$(jq -r .version apps/api/package.json)
MAJMIN=${VERSION%.*}
echo "==> Releasing studio ${VERSION} (platforms: ${PLATFORMS})"

# ---------- GHCR login + idempotency checks (mirrors the prepare job) ----------
gh auth token | docker login "$REGISTRY" -u "$(gh api user -q .login)" --password-stdin >/dev/null \
  || echo "gh-token login failed — relying on existing docker credentials for ghcr.io"

image_exists() { docker manifest inspect "$1" >/dev/null 2>&1; }
NEED_API=true; NEED_NGINX=true
image_exists "$API_IMAGE:$VERSION" && { echo "==> $API_IMAGE:$VERSION already in GHCR, skipping"; NEED_API=false; }
image_exists "$NGINX_IMAGE:$VERSION" && { echo "==> $NGINX_IMAGE:$VERSION already in GHCR, skipping"; NEED_NGINX=false; }
NEED_NPM=false
if $DO_NPM && ! npm view "decocms@$VERSION" version >/dev/null 2>&1; then NEED_NPM=true; fi

# ---------- 2. build tarball once, exactly like the build-dist job ----------
TARBALL=""
if $NEED_API || $NEED_NGINX || $NEED_NPM; then
  echo "==> Building combined distribution + tarball"
  bun install --frozen-lockfile
  bun run build:studio
  test -f apps/api/dist/client/index.html
  test -f apps/api/dist/server/server.js
  (cd apps/api && rm -f decocms-*.tgz && npm pack >/dev/null)
  TARBALL="$(find "$ROOT/apps/api" -maxdepth 1 -name "decocms-${VERSION}.tgz" -print -quit)"
  [ -n "$TARBALL" ] || { echo "npm pack produced no decocms-${VERSION}.tgz — version mismatch?" >&2; exit 1; }
  (cd apps/api && bun run scripts/smoke-tarball.ts "$TARBALL")
fi

# ---------- multi-arch buildx (docker-container driver, like CI's setup-buildx) ----------
if $NEED_API || $NEED_NGINX; then
  docker buildx inspect studio-manual >/dev/null 2>&1 || docker buildx create --name studio-manual >/dev/null
fi

if $NEED_API; then
  echo "==> Building + pushing $API_IMAGE:$VERSION"
  CTX="$(mktemp -d)"
  cp "$TARBALL" "$CTX/decocms.tgz"
  docker buildx build --builder studio-manual --platform "$PLATFORMS" --push --provenance=false \
    -f apps/api/Dockerfile \
    -t "$API_IMAGE:$VERSION" -t "$API_IMAGE:$MAJMIN" -t "$API_IMAGE:latest" \
    "$CTX"
  rm -rf "$CTX"
fi

if $NEED_NGINX; then
  echo "==> Building + pushing $NGINX_IMAGE:$VERSION"
  cp "$TARBALL" "$ROOT/decocms.tgz"
  trap 'rm -f "$ROOT/decocms.tgz"' EXIT
  docker buildx build --builder studio-manual --platform "$PLATFORMS" --push --provenance=false \
    -f apps/web/Dockerfile \
    -t "$NGINX_IMAGE:$VERSION" -t "$NGINX_IMAGE:$MAJMIN" -t "$NGINX_IMAGE:latest" \
    "$ROOT"
  rm -f "$ROOT/decocms.tgz"
fi

# ---------- optional npm publish (no --provenance: that needs OIDC in CI) ----------
if $DO_NPM; then
  if $NEED_NPM; then
    echo "==> Publishing decocms@$VERSION to npm"
    TAG=latest; case "$VERSION" in *-*) TAG=next ;; esac
    (cd apps/api && npm publish "decocms-${VERSION}.tgz" --access public --tag "$TAG")
  else
    echo "==> decocms@$VERSION already on npm, skipping publish"
  fi
else
  echo "NOTE: skipping npm publish — bunx decocms@$VERSION won't resolve until Actions re-runs or you pass --npm"
fi

# ---------- 3. deco-apps-cd bump (verbatim logic from bump-studio-image.yml) ----------
if $SKIP_CD; then
  echo "==> --skip-cd: not touching $CD_REPO"; exit 0
fi
echo "==> Bumping image tag in $CD_REPO (stg + prod values)"
CD_DIR="$(mktemp -d)"
gh repo clone "$CD_REPO" "$CD_DIR" -- --depth 1 --quiet
cd "$CD_DIR"

bump_api() {
  perl -pi -e '$f=1 if m{repository: ghcr\.io/decocms/studio/studio\s*$};
               if ($f && s/^(\s*)tag: .*/$1tag: "'"$VERSION"'"/) { $f=0 }' "$1"
}
bump_nginx() {
  perl -pi -e '$f=1 if m{^\s+nginx:\s*$};
               if ($f && s/^(\s*)tag: .*/$1tag: "'"$VERSION"'"/) { $f=0 }' "$1"
}
bump() {
  bump_api "$1"; bump_nginx "$1"
  grep -q "tag: \"${VERSION}\"" "$1" || { echo "failed to set tag in $1" >&2; exit 1; }
}
bump apps/deco-studio-stg/values.yaml
bump apps/deco-studio/values.yaml

if git diff --quiet; then
  echo "==> $CD_REPO already at ${VERSION} — nothing to commit"
else
  git commit -aqm "chore(studio): bump mesh image to ${VERSION} (stg + prod, scope: both, manual)"
  for i in 1 2 3; do
    git pull --rebase origin main --quiet && git push --quiet && break
    [ "$i" = 3 ] && { echo "push to $CD_REPO rejected 3x" >&2; exit 1; }
    sleep $((i * 3))
  done
  echo "==> Pushed bump to $CD_REPO"
fi
cd "$ROOT" && rm -rf "$CD_DIR"

echo
echo "Done. studio ${VERSION}:"
echo "  - images: $API_IMAGE:$VERSION + $NGINX_IMAGE:$VERSION"
echo "  - stg (deco-studio-stg): auto-sync — ArgoCD rolls it out on its own"
echo "  - prod (deco-studio): OutOfSync — promote with a manual Sync in ArgoCD"

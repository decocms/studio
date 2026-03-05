#!/usr/bin/env bash
set -euo pipefail

# Publish @decocms/studio as a wrapper for @decocms/mesh.
#
# This script:
#   1. Reads the current @decocms/mesh version
#   2. Patches packages/studio/package.json to use that exact version
#   3. Publishes @decocms/studio to npm with the same version & tag
#   4. Restores the workspace:* dependency afterward
#
# Usage:
#   ./packages/studio/scripts/publish.sh          # publish (dry-run)
#   ./packages/studio/scripts/publish.sh --run     # publish for real
#   ./packages/studio/scripts/publish.sh --run --tag next  # publish as prerelease

STUDIO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MESH_PKG="$(cd "$STUDIO_DIR/../../apps/mesh" && pwd)/package.json"

if [ ! -f "$MESH_PKG" ]; then
  echo "❌ Could not find apps/mesh/package.json"
  exit 1
fi

MESH_VERSION=$(node -e "console.log(require('$MESH_PKG').version)")
echo "📦 @decocms/mesh version: $MESH_VERSION"

# Parse args
DRY_RUN=true
NPM_TAG=""
for arg in "$@"; do
  case "$arg" in
    --run) DRY_RUN=false ;;
    --tag) shift_next=true ;;
    *)
      if [ "${shift_next:-}" = "true" ]; then
        NPM_TAG="$arg"
        shift_next=false
      fi
      ;;
  esac
done

# Auto-detect tag from version if not specified
if [ -z "$NPM_TAG" ]; then
  if [[ "$MESH_VERSION" == *-* ]]; then
    NPM_TAG="next"
  else
    NPM_TAG="latest"
  fi
fi

echo "🏷️  npm tag: $NPM_TAG"

# Check if already published
if npm view "@decocms/studio@$MESH_VERSION" version >/dev/null 2>&1; then
  echo "⏭️  @decocms/studio@$MESH_VERSION already published, skipping."
  exit 0
fi

# Patch package.json: set version and pin dependency
cd "$STUDIO_DIR"
cp package.json package.json.bak
trap 'mv -f "$STUDIO_DIR/package.json.bak" "$STUDIO_DIR/package.json" 2>/dev/null; echo "🔄 Restored workspace:* dependency in package.json"' EXIT

node -e "
const pkg = require('./package.json');
pkg.version = '$MESH_VERSION';
pkg.dependencies['@decocms/mesh'] = '$MESH_VERSION';
require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

echo "✅ Patched studio package.json → v$MESH_VERSION"

# Publish
if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "🧪 DRY RUN — would publish:"
  echo "   npm publish --access public --tag $NPM_TAG"
  echo ""
  echo "   Run with --run to publish for real."
  npm publish --dry-run --access public --tag "$NPM_TAG" 2>&1 || true
else
  echo ""
  echo "🚀 Publishing @decocms/studio@$MESH_VERSION..."
  npm publish --access public --tag "$NPM_TAG"
  echo "✅ Published @decocms/studio@$MESH_VERSION"
fi

# Trap handler restores package.json on exit

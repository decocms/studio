#!/bin/sh
# Cargo target runner for the macOS native dev app.
#
# Only the actual Tauri executable is signed. Cargo also routes test binaries
# through this runner, and those should execute without touching Keychain.

set -eu

bin="$1"
if [ "${bin##*/}" != "deco" ]; then
  exec "$@"
fi

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
. "$script_dir/dev-signing-identity.sh"
native_dir=$(CDPATH='' cd "$script_dir/.." && pwd)
config_path="$native_dir/.dev-signing-identity"

if ! load_dev_signing_identity_config "$config_path"; then
  echo "error: no valid native dev-signing identity is configured" >&2
  echo "run 'bun run --cwd apps/native dev:signing:setup' once" >&2
  exit 1
fi

identifier="$DEV_SIGNING_APP_IDENTIFIER"
designated_requirement="designated => identifier \"$identifier\" and certificate leaf = H\"$SIGNING_IDENTITY_HASH\""
test_requirement="identifier \"$identifier\" and certificate leaf = H\"$SIGNING_IDENTITY_HASH\""

signature=$(codesign -d --verbose=4 --requirements - "$bin" 2>&1 || true)
signature_is_current=false
if printf '%s\n' "$signature" | grep -Fqx "Authority=$SIGNING_IDENTITY_NAME" &&
  printf '%s\n' "$signature" | grep -F "identifier \"$identifier\"" >/dev/null &&
  printf '%s\n' "$signature" | grep -Fi "certificate leaf = H\"$SIGNING_IDENTITY_HASH\"" >/dev/null &&
  codesign --verify --strict --test-requirement "=$test_requirement" "$bin" >/dev/null 2>&1; then
  signature_is_current=true
fi

if [ "$signature_is_current" != true ]; then
  codesign \
    --force \
    --sign "$SIGNING_IDENTITY_HASH" \
    --identifier "$identifier" \
    --requirements "=$designated_requirement" \
    "$bin"
fi

# One verification, not two: `--test-requirement` ADDS the explicit-requirement
# check on top of the standard one, so this single call already reports "valid
# on disk" and "satisfies its Designated Requirement" before it reports
# "explicit requirement satisfied". A bare `--verify` alongside it re-ran the
# same checks and printed those two lines twice, including on the failure path
# (a wrong-identity binary still passes both before failing here), so it added
# no signal.
codesign \
  --verify \
  --strict \
  --verbose=2 \
  --test-requirement "=$test_requirement" \
  "$bin"

signature=$(codesign -d --verbose=4 --requirements - "$bin" 2>&1)
if ! printf '%s\n' "$signature" | grep -Fqx "Authority=$SIGNING_IDENTITY_NAME" ||
  ! printf '%s\n' "$signature" | grep -Fqx "Identifier=$identifier" ||
  ! printf '%s\n' "$signature" | grep -F "identifier \"$identifier\"" >/dev/null ||
  ! printf '%s\n' "$signature" | grep -Fi "certificate leaf = H\"$SIGNING_IDENTITY_HASH\"" >/dev/null; then
  echo "error: dev binary does not carry the configured self-signed identity and designated requirement" >&2
  exit 1
fi

exec "$@"

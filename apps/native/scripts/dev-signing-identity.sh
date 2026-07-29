#!/bin/sh

DEV_SIGNING_IDENTITY_NAME="decocms-dev"
DEV_SIGNING_APP_IDENTIFIER="com.decocms.studio"
DEV_KEYCHAIN_HELPER_IDENTIFIER="com.decocms.studio.dev-keychain-helper"
DEV_KEYCHAIN_HELPER_SERVICE="com.decocms.studio.dev"
# This is also the installed-helper upgrade boundary. Bump it whenever helper
# behavior changes so an explicit setup rerun replaces the old fixed bytes.
DEV_KEYCHAIN_HELPER_PROTOCOL_VERSION="2"

# Resolve the one valid self-signed development identity without relying on
# Keychain enumeration order. Sets SIGNING_IDENTITY_HASH and
# SIGNING_IDENTITY_NAME for the caller.
discover_dev_signing_identity() {
  keychain="${1-}"
  identity_output=$(mktemp "${TMPDIR:-/tmp}/decocms-signing-identities.XXXXXX")
  if [ -n "$keychain" ]; then
    security find-identity -v -p codesigning "$keychain" >"$identity_output" 2>/dev/null &
  else
    security find-identity -v -p codesigning >"$identity_output" 2>/dev/null &
  fi
  security_pid=$!
  (
    sleep 8
    kill "$security_pid" 2>/dev/null || true
  ) &
  watchdog_pid=$!
  security_status=0
  wait "$security_pid" || security_status=$?
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  identities=$(cat "$identity_output")
  rm -f "$identity_output"

  if [ "$security_status" -ne 0 ]; then
    echo "Could not enumerate code-signing identities (the login Keychain may be locked or awaiting another dialog)." >&2
    return 2
  fi

  matches=$(
    printf '%s\n' "$identities" | awk -F '"' -v wanted="$DEV_SIGNING_IDENTITY_NAME" '
      $2 == wanted {
        hash = $1
        sub(/^[[:space:]]*[0-9]+\)[[:space:]]*/, "", hash)
        sub(/[[:space:]]+$/, "", hash)
        print hash "\t" $2
      }
    '
  )
  match_count=$(printf '%s\n' "$matches" | awk 'NF { count++ } END { print count + 0 }')

  if [ "$match_count" -eq 0 ]; then
    return 1
  fi

  if [ "$match_count" -ne 1 ]; then
    echo "Multiple valid '$DEV_SIGNING_IDENTITY_NAME' identities are installed:" >&2
    printf '%s\n' "$matches" | awk -F '\t' '{ printf "  %s  %s\n", $1, $2 }' >&2
    echo "Remove the duplicate identity in Keychain Access, then run setup again." >&2
    return 2
  fi

  SIGNING_IDENTITY_HASH=$(printf '%s\n' "$matches" | cut -f 1 | tr '[:lower:]' '[:upper:]')
  SIGNING_IDENTITY_NAME=$(printf '%s\n' "$matches" | cut -f 2-)
}

write_dev_signing_identity_config() {
  config_path="$1"
  config_tmp="$config_path.tmp.$$"
  umask 077
  {
    printf '%s\n' "$SIGNING_IDENTITY_HASH"
    printf '%s\n' "$SIGNING_IDENTITY_NAME"
  } >"$config_tmp"
  mv -f "$config_tmp" "$config_path"
}

load_dev_signing_identity_config() {
  config_path="$1"
  if [ ! -f "$config_path" ]; then
    return 1
  fi

  SIGNING_IDENTITY_HASH=$(sed -n '1p' "$config_path" | tr '[:lower:]' '[:upper:]')
  SIGNING_IDENTITY_NAME=$(sed -n '2p' "$config_path")
  unexpected_line=$(sed -n '3p' "$config_path")

  if [ -n "$unexpected_line" ] || [ "${#SIGNING_IDENTITY_HASH}" -ne 40 ]; then
    return 1
  fi
  case "$SIGNING_IDENTITY_HASH" in
    *[!0-9A-F]*) return 1 ;;
  esac
  if [ "$SIGNING_IDENTITY_NAME" != "$DEV_SIGNING_IDENTITY_NAME" ]; then
    return 1
  fi
}

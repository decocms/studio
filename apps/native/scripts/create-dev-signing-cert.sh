#!/bin/sh
# Create or reuse the stable self-signed identity used by `tauri dev`.

set -eu
umask 077

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Native dev signing setup is only required on macOS." >&2
  exit 1
fi

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
. "$script_dir/dev-signing-identity.sh"
native_dir=$(CDPATH='' cd "$script_dir/.." && pwd)
config_path="$native_dir/.dev-signing-identity"
openssl_bin="${DECOCMS_OPENSSL_BIN:-/usr/bin/openssl}"
login_keychain=$(security default-keychain -d user | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//')
user_home="${HOME:-}"

case "$user_home" in
  /*) ;;
  *)
    echo "Could not resolve an absolute home directory for the development Keychain helper." >&2
    exit 1
    ;;
esac

helper_install_dir="$user_home/Library/Application Support/com.decocms.studio/dev"
helper_path="$helper_install_dir/decocms-keychain-helper"

if [ -z "$login_keychain" ] || [ ! -f "$login_keychain" ]; then
  echo "Could not resolve the login Keychain." >&2
  exit 1
fi
if [ ! -x "$openssl_bin" ]; then
  echo "Could not execute macOS OpenSSL at '$openssl_bin'." >&2
  exit 1
fi

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/decocms-dev-signing.XXXXXX")
created_identity_hash=""
installed_helper_during_setup=false
setup_complete=false
cleanup() {
  if [ "$installed_helper_during_setup" = true ] && [ "$setup_complete" != true ]; then
    rm -f "$helper_path"
  fi
  if [ -n "$created_identity_hash" ] && [ "$setup_complete" != true ]; then
    security delete-identity \
      -Z "$created_identity_hash" \
      -t \
      "$login_keychain" >/dev/null 2>&1 ||
      security delete-certificate \
        -Z "$created_identity_hash" \
        -t \
        "$login_keychain" >/dev/null 2>&1 ||
      true
  fi
  rm -r "$temp_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

certificate_file="$temp_dir/certificate.pem"

exact_certificate_hashes() {
  security find-certificate \
    -a \
    -c "$DEV_SIGNING_IDENTITY_NAME" \
    -Z \
    "$login_keychain" 2>/dev/null |
    awk -v wanted="$DEV_SIGNING_IDENTITY_NAME" '
      /^SHA-1 hash:/ { hash = $3 }
      /"alis"<blob>=/ {
        alias = $0
        sub(/^.*"alis"<blob>="/, "", alias)
        sub(/".*$/, "", alias)
        if (alias == wanted && hash != "") {
          print toupper(hash)
        }
        hash = ""
      }
    '
}

export_configured_certificate() {
  candidates_file="$temp_dir/candidates.pem"
  security find-certificate \
    -a \
    -c "$SIGNING_IDENTITY_NAME" \
    -p \
    "$login_keychain" >"$candidates_file"
  awk -v directory="$temp_dir" '
    /-----BEGIN CERTIFICATE-----/ {
      count++
      output = sprintf("%s/candidate-%d.pem", directory, count)
    }
    output != "" { print > output }
    /-----END CERTIFICATE-----/ {
      close(output)
      output = ""
    }
  ' "$candidates_file"

  matching_count=0
  for candidate in "$temp_dir"/candidate-*.pem; do
    if [ ! -f "$candidate" ]; then
      continue
    fi
    candidate_hash=$(
      "$openssl_bin" x509 -in "$candidate" -noout -fingerprint -sha1 |
        sed 's/^.*=//; s/://g' |
        tr '[:lower:]' '[:upper:]'
    )
    if [ "$candidate_hash" = "$SIGNING_IDENTITY_HASH" ]; then
      cp "$candidate" "$certificate_file"
      matching_count=$((matching_count + 1))
    fi
  done

  if [ "$matching_count" -ne 1 ]; then
    echo "Could not export the exact '$SIGNING_IDENTITY_NAME' certificate with SHA-1 $SIGNING_IDENTITY_HASH." >&2
    return 1
  fi
}

identity_status=0
discover_dev_signing_identity "$login_keychain" || identity_status=$?
if [ "$identity_status" -ne 0 ]; then
  if [ "$identity_status" -ne 1 ]; then
    exit "$identity_status"
  fi

  existing_hashes=$(exact_certificate_hashes)
  existing_count=$(printf '%s\n' "$existing_hashes" | awk 'NF { count++ } END { print count + 0 }')

  if [ "$existing_count" -gt 1 ]; then
    echo "Multiple certificates named '$DEV_SIGNING_IDENTITY_NAME' exist in the login Keychain." >&2
    printf '%s\n' "$existing_hashes" | sed 's/^/  /' >&2
    echo "Remove the duplicates in Keychain Access, then run setup again." >&2
    exit 1
  fi

  if [ "$existing_count" -eq 1 ]; then
    existing_hash=$(printf '%s\n' "$existing_hashes" | awk 'NF { print; exit }')
    cat >&2 <<EOF
A certificate named '$DEV_SIGNING_IDENTITY_NAME' already exists but is not a
valid code-signing identity. Setup will not change trust settings based on a
display name alone. Inspect it in Keychain Access, or remove only that exact
certificate/identity before retrying:

  security delete-identity -Z "$existing_hash" -t "$login_keychain" ||
    security delete-certificate -Z "$existing_hash" -t "$login_keychain"
EOF
    exit 1
  else
    openssl_config="$temp_dir/openssl.cnf"
    private_key="$temp_dir/private-key.pem"
    cat >"$openssl_config" <<EOF
[req]
distinguished_name = distinguished_name
x509_extensions = code_signing
prompt = no

[distinguished_name]
CN = $DEV_SIGNING_IDENTITY_NAME
O = deco.cx
OU = Local Development

[code_signing]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

    echo "Creating the self-signed '$DEV_SIGNING_IDENTITY_NAME' code-signing identity."
    "$openssl_bin" genrsa -out "$private_key" 2048
    "$openssl_bin" req \
      -x509 \
      -new \
      -sha256 \
      -days 3650 \
      -key "$private_key" \
      -out "$certificate_file" \
      -config "$openssl_config"
    created_identity_hash=$(
      "$openssl_bin" x509 -in "$certificate_file" -noout -fingerprint -sha1 |
        sed 's/^.*=//; s/://g' |
        tr '[:lower:]' '[:upper:]'
    )

    security import \
      "$certificate_file" \
      -k "$login_keychain" \
      -t cert \
      -f pemseq

    echo "macOS may request approval to trust the new local development certificate."
    security add-trusted-cert \
      -r trustRoot \
      -p codeSign \
      -k "$login_keychain" \
      "$certificate_file"

    security import \
      "$private_key" \
      -k "$login_keychain" \
      -t priv \
      -f openssl \
      -x \
      -T /usr/bin/codesign

    identity_status=0
    discover_dev_signing_identity "$login_keychain" || identity_status=$?
    if [ "$identity_status" -ne 0 ]; then
      cat >&2 <<EOF
The certificate was imported, but macOS does not expose it as a valid
code-signing identity. Setup is removing the identity it just created.
EOF
      exit 1
    fi
  fi
fi

export_configured_certificate
if ! "$openssl_bin" x509 -in "$certificate_file" -noout -checkend 86400 >/dev/null; then
  echo "The '$SIGNING_IDENTITY_NAME' certificate is expired or expires within 24 hours." >&2
  exit 1
fi

designated_requirement="designated => identifier \"$DEV_SIGNING_APP_IDENTIFIER\" and certificate leaf = H\"$SIGNING_IDENTITY_HASH\""
test_requirement="identifier \"$DEV_SIGNING_APP_IDENTIFIER\" and certificate leaf = H\"$SIGNING_IDENTITY_HASH\""
helper_designated_requirement="designated => identifier \"$DEV_KEYCHAIN_HELPER_IDENTIFIER\" and certificate leaf = H\"$SIGNING_IDENTITY_HASH\""
helper_test_requirement="identifier \"$DEV_KEYCHAIN_HELPER_IDENTIFIER\" and certificate leaf = H\"$SIGNING_IDENTITY_HASH\""

echo "Verifying private-key access. If macOS asks, choose Always Allow once."
probe_index=0
for probe_source in /usr/bin/true /usr/bin/whoami; do
  probe_index=$((probe_index + 1))
  probe="$temp_dir/signing-probe-$probe_index"
  cp "$probe_source" "$probe"
  codesign \
    --force \
    --sign "$SIGNING_IDENTITY_HASH" \
    --identifier "$DEV_SIGNING_APP_IDENTIFIER" \
    --requirements "=$designated_requirement" \
    "$probe"
  codesign \
    --verify \
    --strict \
    --test-requirement "=$test_requirement" \
    "$probe"
done

helper_protocol_probe() {
  candidate="$1"
  response=$(
    printf '{"version":%s,"operation":"probe"}\n' "$DEV_KEYCHAIN_HELPER_PROTOCOL_VERSION" |
      "$candidate" 2>/dev/null
  ) || return 1
  [ "$response" = "{\"version\":$DEV_KEYCHAIN_HELPER_PROTOCOL_VERSION,\"status\":\"ok\"}" ]
}

helper_is_current() {
  candidate="$1"
  if [ ! -f "$candidate" ] || [ -L "$candidate" ]; then
    return 1
  fi
  if [ "$(stat -f '%Lp' "$candidate" 2>/dev/null || true)" != "700" ]; then
    return 1
  fi
  if ! codesign \
    --verify \
    --strict \
    --test-requirement "=$helper_test_requirement" \
    "$candidate" >/dev/null 2>&1; then
    return 1
  fi
  helper_protocol_probe "$candidate"
}

install_keychain_helper() {
  cargo_target_dir="${CARGO_TARGET_DIR:-$native_dir/target}"
  echo "Building the fixed development Keychain helper."
  CARGO_TARGET_DIR="$cargo_target_dir" cargo build \
    --manifest-path "$native_dir/Cargo.toml" \
    --package upstream \
    --bin decocms-keychain-helper

  built_helper="$cargo_target_dir/debug/decocms-keychain-helper"
  if [ ! -f "$built_helper" ]; then
    echo "Cargo did not produce the development Keychain helper at '$built_helper'." >&2
    return 1
  fi

  mkdir -p "$helper_install_dir"
  chmod 700 "$helper_install_dir"
  install_candidate="$helper_install_dir/.decocms-keychain-helper.install.$$"
  cp "$built_helper" "$install_candidate"
  chmod 700 "$install_candidate"
  codesign \
    --force \
    --sign "$SIGNING_IDENTITY_HASH" \
    --identifier "$DEV_KEYCHAIN_HELPER_IDENTIFIER" \
    --requirements "=$helper_designated_requirement" \
    "$install_candidate"
  codesign \
    --verify \
    --strict \
    --test-requirement "=$helper_test_requirement" \
    "$install_candidate"
  if ! helper_protocol_probe "$install_candidate"; then
    rm -f "$install_candidate"
    echo "The newly built development Keychain helper failed its protocol/Keychain probe." >&2
    return 1
  fi

  mv -f "$install_candidate" "$helper_path"
  installed_helper_during_setup=true
}

if helper_is_current "$helper_path"; then
  echo "Reusing the existing fixed development Keychain helper at:"
  echo "  $helper_path"
else
  install_keychain_helper
fi

setup_complete=true
write_dev_signing_identity_config "$config_path"
echo "Self-signed development identity ready: $SIGNING_IDENTITY_NAME"
echo "Certificate SHA-1: $SIGNING_IDENTITY_HASH"
echo "Saved the non-secret certificate selection to $config_path."
echo "Fixed Keychain helper ready: $helper_path"
echo "Dev sessions remain in macOS Keychain under $DEV_KEYCHAIN_HELPER_SERVICE."

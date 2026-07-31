#!/usr/bin/env bash
# Fetches the pinned rclone into `src-tauri/binaries/` for Tauri to bundle as
# an `externalBin` (the org filesystem's NFS mount — see
# `apps/native/docs/org-fs-plan.md`).
#
# NOT committed to the repo: the binary is 78 MB per architecture, 156 MB for
# both. This runs from `beforeBuildCommand`, so `tauri build` stays
# self-sufficient, and `src-tauri/binaries/` is git-ignored.
#
# The OFFICIAL rclone.org build is required — Homebrew's ships without `mount`,
# so it cannot serve an NFS mount at all.
#
# Every download is verified against the release's published `SHA256SUMS`
# before it is unpacked. A binary that lands inside a signed, hardened-runtime
# app bundle is worth pinning by content, not just by version: the version
# alone would let a compromised or re-cut release through silently.
set -euo pipefail

RCLONE_VERSION="v1.74.4"

cd "$(dirname "$0")/.."
DEST="src-tauri/binaries"
mkdir -p "$DEST"

# Tauri resolves an externalBin by appending the Rust host triple, and the
# bundler strips it again when copying into `<App>.app/Contents/MacOS/`.
# Ask rustc rather than hardcoding, so a cross-build picks the right one.
host_triple() {
  rustc --print host-tuple 2>/dev/null || rustc -vV | awk '/^host: /{print $2}'
}

# rclone.org release slugs — Go arch names, not Rust triple fragments, so the
# mapping is spelled out rather than derived. Windows is out of scope: it
# additionally needs WinFsp, a third-party kernel driver. The Linux binary is
# bundled from day one but stays unused until the org filesystem is ported
# (see `apps/native/docs/linux-support-plan.md`).
slug_for_triple() {
  case "$1" in
    aarch64-apple-darwin) echo "osx-arm64" ;;
    x86_64-apple-darwin) echo "osx-amd64" ;;
    x86_64-unknown-linux-gnu) echo "linux-amd64" ;;
    aarch64-unknown-linux-gnu) echo "linux-arm64" ;;
    *) return 1 ;;
  esac
}

# macOS ships `shasum` but no `sha256sum`; most Linux distros ship the reverse.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'
}

fetch_one() {
  local triple="$1" slug out zip name tmp expected actual
  if ! slug="$(slug_for_triple "$triple")"; then
    echo "[rclone] no official build for ${triple}; skipping" >&2
    return 0
  fi

  out="${DEST}/rclone-${triple}"
  # Re-running a build must not re-download 78 MB. The version is in the
  # filename of the marker, so bumping RCLONE_VERSION invalidates it.
  if [ -x "$out" ] && [ -f "${out}.${RCLONE_VERSION}" ]; then
    echo "[rclone] ${triple} already at ${RCLONE_VERSION}"
    return 0
  fi

  name="rclone-${RCLONE_VERSION}-${slug}"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  echo "[rclone] fetching ${name}"
  curl -fsSL --retry 3 -o "${tmp}/rclone.zip" \
    "https://downloads.rclone.org/${RCLONE_VERSION}/${name}.zip"
  curl -fsSL --retry 3 -o "${tmp}/SHA256SUMS" \
    "https://downloads.rclone.org/${RCLONE_VERSION}/SHA256SUMS"

  expected="$(awk -v f="${name}.zip" '$2 == f || $2 == "*"f {print $1}' "${tmp}/SHA256SUMS")"
  if [ -z "$expected" ]; then
    echo "[rclone] ${name}.zip is not listed in SHA256SUMS — refusing" >&2
    return 1
  fi
  actual="$(sha256_of "${tmp}/rclone.zip")"
  if [ "$expected" != "$actual" ]; then
    echo "[rclone] checksum mismatch for ${name}.zip" >&2
    echo "[rclone]   expected ${expected}" >&2
    echo "[rclone]   actual   ${actual}" >&2
    return 1
  fi

  unzip -q -o "${tmp}/rclone.zip" -d "$tmp"
  install -m 0755 "${tmp}/${name}/rclone" "$out"
  # Marker records which version this binary is, so the cache check above can
  # tell "already fetched" from "fetched a different version".
  rm -f "${out}".v* && : > "${out}.${RCLONE_VERSION}"
  echo "[rclone] installed ${out}"
}

# The host triple always, so `tauri build` on this machine works. A universal
# or cross build additionally wants the other arch — pass triples explicitly.
if [ "$#" -gt 0 ]; then
  for triple in "$@"; do fetch_one "$triple"; done
else
  fetch_one "$(host_triple)"
fi

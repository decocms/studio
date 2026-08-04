#!/usr/bin/env bash
# THE PINNED APPIMAGE TOOLING MANIFEST — single source of truth for the five
# third-party binaries the Tauri AppImage bundler shells out to, plus the
# fetch/verify logic that seeds them into the CLI's tools cache.
#
# Read by BOTH workflows, on purpose:
#   - .github/workflows/release-native.yaml  (the shipped AppImage)
#   - .github/workflows/native.yml           (the PR/main AppImage that gets
#                                             boot-smoked and asserted not to
#                                             require libfuse2)
# Same reason `fetch-rclone.sh` next door is shared: a pin that only the
# release leg exercises is first tested on release day, on a half-published
# version, where the failure is maximally expensive and cannot go red on the
# PR that introduced it. With both legs seeded from this file, a stale or
# wrong pin fails the PR's `tauri-build` ubuntu leg instead.
#
# WHY PRE-SEED AT ALL (release leg): the AppImage bundler shells out to
# linuxdeploy and its plugins, which INHERIT the environment of `tauri build`
# — the one step holding TAURI_SIGNING_PRIVATE_KEY. Left to itself the
# bundler downloads all five tools at build time from `continuous`/`master`
# refs, i.e. it would execute unpinned third-party bytes next to the private
# key, an exposure the macOS leg does not have. Pre-seeding the cache with
# content-verified copies means `prepare_tools` finds every file already
# present and makes no network request at all. Both callers therefore run
# this script strictly BEFORE the signing key enters scope.
#
# Every URL is an immutable ref (a frozen release tag or a commit sha), never
# `continuous`/`master`: a digest pinned against a rolling ref is a time bomb,
# since the bytes it names stop existing the moment upstream re-cuts, and a
# repair dispatch months from now must still reproduce this build. Verified
# against tauri-bundler at tag tauri-cli-v2.11.4 (linuxdeploy.rs
# `prepare_tools`): these are the exact filenames it probes in the tools
# cache, and it zeroes three magic bytes inside linuxdeploy AFTER this script
# runs — so the checksum must be taken here, never on the post-build file.
#
# Bumping a pin: fetch, verify provenance, then update BOTH the URL and the
# digest on the same row. x86_64 only — a linux-aarch64 leg needs its own
# AppRun-aarch64 / linuxdeploy-aarch64 / plugin-aarch64 rows and a matching
# arch guard below.
set -euo pipefail

# name  sha256  url  (one row per tool; whitespace-separated, no comments)
pins() {
  cat <<'PINS'
AppRun-x86_64 f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64
linuxdeploy-x86_64.AppImage e762bea85c8eb0d4b3508d46e5c1f037f717d0f9303ae3b4aafc8b04991fa1ef https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage
linuxdeploy-plugin-gtk.sh cb379f9b0733e9ad9f8bd78f8c2fa038aef2478523bb7d4c8e64ff6a1ea3501a https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/b5eb8d05b4c0ed40107fe2158c5d8527f94568ef/linuxdeploy-plugin-gtk.sh
linuxdeploy-plugin-gstreamer.sh c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94 https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/2a2e67491c32995a3f279ad0ecbe77abd512b42a/linuxdeploy-plugin-gstreamer.sh
linuxdeploy-plugin-appimage.AppImage 992d502a248e14ab185448ddf6f6e7d25558cb84d4623c354c3af350c25fccb3 https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/1-alpha-20250213-1/linuxdeploy-plugin-appimage-x86_64.AppImage
PINS
}

# Only the x86_64 Linux bundler consumes these. Fail loudly rather than
# silently seeding a cache the host's bundler will ignore (or worse, seeding
# x86_64 tools for an aarch64 build).
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) ;;
  *)
    echo "[appimage-tools] refusing to run on $(uname -s)/$(uname -m): these pins are linux-x86_64 only" >&2
    exit 1
    ;;
esac

# macOS ships `shasum` but no `sha256sum`; most Linux distros ship the reverse.
sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'
}

TOOLS="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"

# `--verify-only`: run AFTER `tauri build` to assert it downloaded nothing.
# The pin table is not keyed to the CLI version, so a CLI bump that probes a
# name this file does not list (a renamed AppRun, an added sixth tool) would
# have the bundler fetch it from its rolling URL from inside `tauri build` —
# the one step holding the signing key, which is the exposure this file exists
# to remove. A download can only ADD a name, so an exact set comparison
# catches that drift, and it turns the bump into a red PR leg instead of a
# silent release-day fetch.
if [ "${1:-}" = "--verify-only" ]; then
  unpinned=""
  for path in "$TOOLS"/*; do
    [ -e "$path" ] || continue
    name="$(basename "$path")"
    pins | grep -q "^$name " || unpinned="$unpinned $name"
  done
  if [ -n "$unpinned" ]; then
    echo "::error::the Tauri CLI fetched unpinned tooling into $TOOLS:$unpinned. Add each to the pin table in apps/native/scripts/fetch-appimage-tools.sh (with its sha256) — until then a release build downloads it inside the step that holds TAURI_SIGNING_PRIVATE_KEY."
    exit 1
  fi
  echo "[appimage-tools] no unpinned tooling in $TOOLS"
  exit 0
fi

# The tools cache the Tauri CLI probes. Wiped first: a leftover unpinned tool
# from an earlier run (or a linuxdeploy whose magic bytes a previous build
# already zeroed) must never reach a shipping bundle.
rm -rf "$TOOLS"
mkdir -p "$TOOLS"

while read -r name sha url; do
  [ -z "$name" ] && continue
  curl -fsSL --retry 3 -o "$TOOLS/$name" "$url"
  actual="$(sha256_of "$TOOLS/$name")"
  if [ "$sha" != "$actual" ]; then
    echo "::error::checksum mismatch for $name from $url — expected $sha, got $actual. Re-verify the upstream artifact and update the pin in apps/native/scripts/fetch-appimage-tools.sh; never relax the check."
    exit 1
  fi
  chmod +x "$TOOLS/$name"
  echo "[appimage-tools] verified $name"
done < <(pins)

echo "[appimage-tools] seeded $TOOLS"

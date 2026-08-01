#!/bin/sh
# deco studio installer for macOS (Apple Silicon).
#
#   curl -fsSL https://studio.decocms.com/install.sh | sh
#
# What this does, in order (no sudo anywhere):
#   1. adds the decocms/studio Homebrew tap (this repo doubles as the tap)
#   2. marks the tap trusted (Homebrew >= 6 otherwise prompts on install)
#   3. installs or upgrades the deco-studio cask
#   4. while builds are unsigned: clears macOS's quarantine flag so the app
#      can launch (macOS reports unsigned downloads as "damaged"). This step
#      is skipped automatically once releases are signed and notarized.
#
# Source: https://github.com/decocms/studio (apps/web/public/install.sh)
set -eu

APP="/Applications/deco.app"
CASK="deco-studio"
TAP="decocms/studio"
TAP_URL="https://github.com/decocms/studio"
RELEASES="https://github.com/decocms/studio/releases"

say() { printf '\033[1m[deco studio]\033[0m %s\n' "$1"; }
fail() {
  printf '\033[1;31m[deco studio]\033[0m %s\n' "$1" >&2
  exit 1
}

# Linux ships a self-contained AppImage instead — no installer needed, so this
# script stays macOS-only (it is a pure Homebrew cask wrapper).
[ "$(uname -s)" = "Darwin" ] ||
  fail "this installer is macOS-only. On Linux, download deco-<version>-linux-x86_64.AppImage from $RELEASES, chmod +x it and run it."

[ "$(uname -m)" = "arm64" ] ||
  fail "only Apple Silicon builds exist so far. Watch $RELEASES for Intel."

command -v brew > /dev/null 2>&1 ||
  fail "Homebrew is required (https://brew.sh) — or grab the DMG: $RELEASES"

say "adding the $TAP tap"
brew tap "$TAP" "$TAP_URL"

# Homebrew >= 6 gates third-party taps behind a trust prompt; trusting here
# keeps the install below non-interactive. Older Homebrew has no such command.
if brew trust --help > /dev/null 2>&1; then
  say "trusting the $TAP tap"
  brew trust "$TAP"
fi

if brew list --cask "$CASK" > /dev/null 2>&1; then
  say "upgrading $CASK"
  brew upgrade --cask "$CASK" ||
    say "already up to date"
else
  say "installing $CASK"
  brew install --cask "$CASK"
fi

[ -d "$APP" ] || fail "expected $APP after install; check brew output above"

# Unsigned builds arrive quarantined and macOS refuses to open them
# ("damaged"). Only strip the flag while Gatekeeper actually rejects the
# app — once releases are signed + notarized this becomes a no-op.
if ! spctl --assess --type execute "$APP" > /dev/null 2>&1; then
  say "builds are not yet notarized; clearing the quarantine flag"
  xattr -dr com.apple.quarantine "$APP"
fi

say "launching"
open "$APP"
say "done — deco.app is installed. Upgrade later with: brew upgrade --cask $CASK"

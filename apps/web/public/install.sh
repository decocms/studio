#!/bin/sh
# deco studio installer.
#
#   curl -fsSL https://studio.decocms.com/install.sh | sh
#
# Two platforms, two shapes, no sudo on either.
#
# macOS (Apple Silicon) — Homebrew cask:
#   1. adds the decocms/studio Homebrew tap (this repo doubles as the tap)
#   2. marks the tap trusted (Homebrew >= 6 otherwise prompts on install)
#   3. installs or upgrades the deco-studio cask
#   4. while builds are unsigned: clears macOS's quarantine flag so the app
#      can launch (macOS reports unsigned downloads as "damaged"). This step
#      is skipped automatically once releases are signed and notarized.
#
# Linux (x86_64) — the self-contained AppImage, no package manager involved:
#   1. reads the version off the rolling `native-updates` channel manifest
#      (releases/download/native-updates/latest.json — the same document the
#      installed app's updater polls). That manifest is promoted only after
#      EVERY platform's assets are on the immutable native-v<version> release,
#      so every version it names does ship to Linux. It is NOT necessarily the
#      newest one: promotion is throttled (THROTTLE_MS in
#      native-update-channel.mjs, ~20h), so the channel can sit a few releases
#      behind head. releases/latest is not usable here (other workflows publish
#      releases from this repo, so "latest" is not guaranteed to be a native
#      tag), and neither is scanning the release list: this repo publishes both
#      a vX.Y.Z and a native-vX.Y.Z per bump, ~46 releases a day, so one
#      100-item API page spans barely two days — a Linux leg red for longer
#      than that would scroll the newest installable version off the page and
#      this installer would report "never released" about a release that
#      exists. One fixed URL has no such window, and no API rate limit either.
#   2. verifies what it downloads, as strongly as this host can:
#      - with minisign installed: fetches <asset>.tar.gz and its .sig and
#        checks them against the minisign public key EMBEDDED BELOW, then
#        unpacks the AppImage out of that verified tarball. That key rides in
#        with this script from studio.decocms.com — a different origin from the
#        GitHub CDN that serves the release — so it is a genuine out-of-band
#        anchor, and this step really does prove authenticity.
#      - without minisign: falls back to the published .sha256, which detects a
#        CORRUPT OR TRUNCATED download and nothing more. Digest and binary sit
#        on the same release, same origin, same TLS session: whoever can change
#        one can change the other. The script says so out loud rather than
#        downgrading in silence.
#      A missing .sha256 aborts the install either way. Note the asymmetry with
#      macOS: the cask pins its sha256 in git, which is auditable after the
#      fact (the release bot pushes it to main unreviewed, so it is a record,
#      not an approval). Without minisign the Linux path has no out-of-band
#      anchor at all.
#   3. installs to ~/.local/bin/deco-studio with a matching
#      ~/.local/share/applications entry (plus its icon), replacing any
#      previous install in place.
#   4. probes for FUSE, which the AppImage runtime needs to self-mount, and
#      falls back to --appimage-extract-and-run when the host has none.
#
# Source: https://github.com/decocms/studio (apps/web/public/install.sh)
set -eu

REPO="decocms/studio"
APP="/Applications/deco.app"
CASK="deco-studio"
TAP="decocms/studio"
TAP_URL="https://github.com/$REPO"
RELEASES="https://github.com/$REPO/releases"
# The rolling updater channel: one stable URL, promoted only once every
# platform's assets are on the immutable release (release-native.yaml's
# `promote` job holds it back otherwise). Same document the installed app
# polls — see plugins.updater.endpoints in apps/native/src-tauri/tauri.conf.json5.
UPDATE_CHANNEL="$RELEASES/download/native-updates/latest.json"

# The minisign PUBLIC key every updater artifact is signed with — the same pin
# the shipped app verifies against, stored base64-wrapped in
# apps/native/src-tauri/tauri.conf.json5 (plugins.updater.pubkey) and used by
# release-native.yaml's promote job. A public key only verifies, so shipping it
# in a public script costs nothing; rotate BOTH copies together.
UPDATER_PUBKEY='untrusted comment: minisign public key: 7E59F0D430876374
RWR0Y4cw1PBZfoLU9KTGnUUpEuO9YnNTHtcSVltHin7c8Xr2mS/QtlK1'

say() { printf '\033[1m[deco studio]\033[0m %s\n' "$1"; }
fail() {
  printf '\033[1;31m[deco studio]\033[0m %s\n' "$1" >&2
  exit 1
}
have() { command -v "$1" > /dev/null 2>&1; }

# ---------------------------------------------------------------- macOS ----

install_macos() {
  [ "$(uname -m)" = "arm64" ] ||
    fail "only Apple Silicon builds exist so far. Watch $RELEASES for Intel."

  have brew ||
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
}

# ---------------------------------------------------------------- Linux ----

# curl is how this script normally arrives, but `wget -qO- … | sh` is just as
# valid an invocation — resolve one downloader up front and use it everywhere.
fetch() {
  if [ "$DOWNLOADER" = curl ]; then
    curl -fsSL --retry 3 --retry-delay 1 -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

sha256_of() {
  case "$SHA_TOOL" in
    sha256sum) sha256sum "$1" | cut -d' ' -f1 ;;
    shasum) shasum -a 256 "$1" | cut -d' ' -f1 ;;
    *) openssl dgst -sha256 "$1" | awk '{ print $NF }' ;;
  esac
}

# The bundled runtime is a static type-2 runtime, so it needs no libfuse on
# disk — but self-MOUNTING still needs the kernel's /dev/fuse plus a
# fusermount helper to set it up unprivileged. Missing either one, the runtime
# dies with a terse mount error; --appimage-extract-and-run unpacks to a temp
# directory instead (slower start, no mount, works everywhere).
fuse_ready() {
  [ -e /dev/fuse ] || return 1
  have fusermount3 || have fusermount
}

cleanup() {
  if [ -n "${STAGED:-}" ]; then rm -f "$STAGED"; fi
  if [ -n "${TMP:-}" ]; then rm -rf "$TMP"; fi
}

# Stage inside $BIN_DIR, then rename. Overwriting a RUNNING AppImage in place
# fails with ETXTBSY, while a rename swaps the directory entry and leaves the
# running process on its old inode; staging in the SAME directory is what keeps
# that rename atomic. Shared by both verification paths so the install step
# cannot drift between them.
#
# `$2` is the digest these bytes were proven at BY SIGNATURE, or empty on the
# digest-only path. Written last, so a stamp can never outlive the install it
# describes; cleared on the unsigned path so a downgrade in verification
# strength is never left claiming the stronger one.
#
# NEVER fatal. The stamp is an optimisation — dropping it only costs the next
# run a re-verify, which is the fail-closed direction. It sits AFTER the `mv`
# and BEFORE the icon, the .desktop entry and the completion message, so on
# `set -eu` an unwritable stamp would abort with the binary already in place
# and no launcher entry: a half install that does not self-repair, because
# every re-run takes the same path and dies at the same line.
install_appimage() {
  mkdir -p "$BIN_DIR"
  STAGED="$BIN_DIR/.deco-studio.$$"
  cp "$1" "$STAGED"
  chmod 755 "$STAGED"
  mv -f "$STAGED" "$BIN_PATH"
  STAGED=""
  if [ -n "${2:-}" ]; then
    { mkdir -p "$STAMP_DIR" && printf '%s\n' "$2" > "$STAMP_PATH"; } 2>/dev/null ||
      say "could not record the verification stamp at $STAMP_PATH; the next run will re-verify the signature."
  else
    rm -f "$STAMP_PATH" 2>/dev/null || true
  fi
  INSTALLED_NEW=true
  say "installed $BIN_PATH"
}

install_linux() {
  [ "$(uname -m)" = "x86_64" ] ||
    fail "only linux-x86_64 builds exist so far (this machine reports $(uname -m)); there is no aarch64 release yet. Watch $RELEASES."

  [ -n "${HOME:-}" ] ||
    fail "\$HOME is unset, so there is no per-user directory to install into."

  if have curl; then
    DOWNLOADER=curl
  elif have wget; then
    DOWNLOADER=wget
  else
    fail "curl or wget is required to download the AppImage."
  fi

  if have sha256sum; then
    SHA_TOOL=sha256sum
  elif have shasum; then
    SHA_TOOL=shasum
  elif have openssl; then
    SHA_TOOL=openssl
  else
    fail "no sha256 tool found (sha256sum, shasum or openssl), so the download cannot be verified — refusing to install. Install coreutils, or download and check $RELEASES by hand."
  fi

  BIN_DIR="$HOME/.local/bin"
  BIN_PATH="$BIN_DIR/deco-studio"
  DESKTOP_DIR="$HOME/.local/share/applications"
  DESKTOP_PATH="$DESKTOP_DIR/deco-studio.desktop"
  ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
  ICON_PATH="$ICON_DIR/deco-studio.png"
  # Records WHICH bytes were proven by signature, not merely by digest. The
  # installed AppImage carries no record of how it was verified, so without
  # this a host that took the unsigned fallback and then installed minisign —
  # exactly what that path tells the user to do — would hit the up-to-date
  # shortcut below and never check the signature at all.
  STAMP_DIR="$HOME/.local/share/deco-studio"
  STAMP_PATH="$STAMP_DIR/verified.sha256"

  TMP=$(mktemp -d) || fail "could not create a temporary directory."
  trap 'cleanup; exit 130' INT
  trap 'cleanup; exit 143' TERM
  trap cleanup EXIT

  say "reading the update channel"
  CHANNEL_JSON="$TMP/latest.json"
  # A downloader that exits non-zero has told us nothing about which versions
  # exist — network down, proxy, DNS, 404, GitHub outage. That is a DIFFERENT
  # failure from a manifest we read and could not understand, and neither one
  # may ever be reported as "Linux was never released".
  fetch "$UPDATE_CHANNEL" "$CHANNEL_JSON" ||
    fail "could not fetch the update channel manifest at $UPDATE_CHANNEL — the download itself failed (network, DNS, proxy, a GitHub outage, or that asset is missing), so which version to install is simply unknown. Nothing was installed; re-run once it is reachable, or pick a release by hand from $RELEASES."

  # Prove this is the manifest before blaming anyone for its contents. `curl
  # -fsSL` happily returns a captive-portal or proxy block page with HTTP 200,
  # and the rolling channel asset is the one file in the scheme that is
  # re-uploaded on every promote, so a half-written body is possible. Without
  # this, an HTML block page is reported as a publishing fault and a truncated
  # manifest as "Linux was never released" — both confidently wrong.
  grep -q '"platforms"' "$CHANNEL_JSON" ||
    fail "what came back from $UPDATE_CHANNEL is not the updater manifest (no \"platforms\" object) — most likely a captive portal, an intercepting proxy, or a corrupt channel asset, not a missing release. Nothing was installed."

  # No jq on a bare host: split the document on commas so every field lands on
  # its own line, then read the manifest's single top-level "version". The
  # per-platform entries hold only "url" and "signature", so this cannot match
  # anything else.
  VERSION=$(tr ',' '\n' < "$CHANNEL_JSON" |
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1)
  # It becomes a URL and a filename below, so it has to look like a version.
  case "$VERSION" in
    "" | *[!0-9A-Za-z.+-]*) VERSION="" ;;
    [0-9]*) ;;
    *) VERSION="" ;;
  esac
  [ -n "$VERSION" ] ||
    fail "the update channel manifest at $UPDATE_CHANNEL was downloaded but carries no usable \"version\", so there is nothing to resolve. This is a publishing fault, not a network one — report it at $RELEASES, or install a release by hand from there."

  # The manifest is refused unless it covers EVERY platform the channel serves
  # (native-update-channel.mjs's PLATFORM_ASSETS / buildLatestJson), so a
  # manifest without this key was promoted before Linux was a shipping target —
  # its version genuinely has no AppImage to install. Saying that here beats
  # failing three lines down on a missing checksum, which reads like an outage.
  grep -q '"linux-x86_64"' "$CHANNEL_JSON" ||
    fail "the update channel is serving $VERSION, but that manifest covers no linux-x86_64 build, so there is no Linux release to install yet. Watch $RELEASES."

  TAG="native-v$VERSION"
  ASSET="deco-$VERSION-linux-x86_64.AppImage"
  SUM_ASSET="$ASSET.sha256"
  TARBALL="$ASSET.tar.gz"
  # The AppImage's name INSIDE the signed tarball: the bundler's dpkg
  # vocabulary (amd64), not the release's (x86_64). release-native.yaml asserts
  # this exact name at build time and src-tauri/src/updater.rs parses it.
  MEMBER="deco_${VERSION}_amd64.AppImage"
  BASE="$RELEASES/download/$TAG"
  say "the update channel is serving $VERSION"

  # What this host can prove about the bytes it is about to execute. minisign
  # is the only one of the three that establishes AUTHENTICITY; tar and base64
  # are what it takes to consume the signed artifact (the .sig is
  # base64-wrapped, the payload is a gzipped tar).
  SIG_MISSING=""
  for TOOL in minisign tar base64; do
    have "$TOOL" || SIG_MISSING="${SIG_MISSING:+$SIG_MISSING, }$TOOL"
  done

  # Checksum first: it is a few bytes, it decides whether the ~100 MB download
  # is worth starting, and it doubles as the up-to-date check below. Required
  # on both paths — under the signed path it is the cross-check that the tag's
  # two Linux assets describe the same build.
  fetch "$BASE/$SUM_ASSET" "$TMP/$SUM_ASSET" ||
    fail "could not download $BASE/$SUM_ASSET, so $ASSET cannot be verified and will not be installed. Re-run to retry, or download and check $ASSET yourself from $RELEASES/tag/$TAG."

  EXPECTED=$(cut -d' ' -f1 < "$TMP/$SUM_ASSET" | head -n 1 | tr -d '\r' | tr 'A-F' 'a-f')
  case "$EXPECTED" in
    *[!0-9a-f]*) EXPECTED="" ;;
  esac
  [ "${#EXPECTED}" -eq 64 ] ||
    fail "$SUM_ASSET on $TAG does not hold a sha256 digest, so nothing can be verified against it. Report this at $RELEASES."

  # A re-run against an install that already carries these exact bytes is a
  # no-op: skip the download and only re-assert the desktop integration below.
  #
  # Matching bytes are not enough on their own. A host that took the unsigned
  # fallback, then installed minisign and re-ran — the remedy that path prints
  # — would otherwise exit here having verified nothing, so the instruction
  # would be a no-op against exactly the attacker it warns about (one who
  # serves both the AppImage and its .sha256). So the shortcut also needs
  # either nothing better available on this host, or a stamp proving these
  # bytes already passed the signature check.
  INSTALLED_NEW=false
  if [ -f "$BIN_PATH" ] && [ "$(sha256_of "$BIN_PATH")" = "$EXPECTED" ] &&
    { [ -n "$SIG_MISSING" ] || [ "$(cat "$STAMP_PATH" 2>/dev/null)" = "$EXPECTED" ]; }; then
    say "already up to date at $VERSION"
  elif [ -z "$SIG_MISSING" ]; then
    # The signed path. `deco-$V-linux-x86_64.AppImage.tar.gz` is a gzipped tar
    # of the very AppImage the raw asset serves, published on the same tag with
    # a minisign .sig — the pair release-native.yaml's promote job verifies
    # before it will build a manifest from it. Verifying it HERE, against a key
    # that arrived with this script from a different origin, is the only step
    # in this install that a GitHub-side compromise cannot forge.
    say "minisign is installed here, so the release signature will be checked against the key embedded in this installer"
    PUB="$TMP/updater.pub"
    printf '%s\n' "$UPDATER_PUBKEY" > "$PUB"

    say "downloading $TARBALL"
    fetch "$BASE/$TARBALL" "$TMP/$TARBALL" ||
      fail "could not download $BASE/$TARBALL. Check the network and re-run, or grab $ASSET by hand from $RELEASES/tag/$TAG."
    fetch "$BASE/$TARBALL.sig" "$TMP/$TARBALL.sig" ||
      fail "could not download $BASE/$TARBALL.sig, so the release signature cannot be checked and nothing was installed. Re-run to retry, or grab $ASSET by hand from $RELEASES/tag/$TAG."

    # Tauri publishes the signature base64-wrapped; decoding yields an ordinary
    # minisign .minisig file.
    tr -d '\r\n' < "$TMP/$TARBALL.sig" | base64 -d > "$TMP/$TARBALL.minisig" ||
      fail "$TARBALL.sig on $TAG is not the base64-wrapped minisign signature it should be, so nothing can be verified against it. Report this at $RELEASES."

    minisign -V -p "$PUB" -x "$TMP/$TARBALL.minisig" -m "$TMP/$TARBALL" \
      > /dev/null ||
      fail "$TARBALL does NOT verify against the deco updater signing key embedded in this installer. These are not the bytes deco published — refusing to install. Report this at $RELEASES."
    say "verified $TARBALL against the deco updater signing key"

    mkdir -p "$TMP/unpack"
    tar xzf "$TMP/$TARBALL" -C "$TMP/unpack" ||
      fail "could not unpack the verified $TARBALL. Re-run to retry, or grab $ASSET by hand from $RELEASES/tag/$TAG."

    SRC="$TMP/unpack/$MEMBER"
    if [ ! -f "$SRC" ]; then
      # The member name is asserted at build time, so this is drift, not
      # tampering — the tarball is already proven authentic, and the digest
      # check below still has to pass. Take the AppImage it does contain rather
      # than refusing an otherwise-good install over a rename.
      SRC=""
      for CANDIDATE in "$TMP"/unpack/*.AppImage; do
        if [ -f "$CANDIDATE" ]; then
          SRC="$CANDIDATE"
          break
        fi
      done
    fi
    [ -n "$SRC" ] ||
      fail "the verified $TARBALL contains no AppImage (expected $MEMBER). Report this at $RELEASES."

    # Same bytes on both assets by construction — release-native.yaml copies
    # one build's AppImage into the tarball and hashes it into $SUM_ASSET, and
    # publishes that leg all-or-nothing. A disagreement therefore means the tag
    # carries two different builds, which is a defect to report, not something
    # to install through.
    ACTUAL=$(sha256_of "$SRC")
    [ "$ACTUAL" = "$EXPECTED" ] ||
      fail "the AppImage inside the signature-verified $TARBALL does not match $SUM_ASSET on $TAG — expected $EXPECTED, got $ACTUAL. Those two assets describe different builds, so one of them is wrong; nothing was installed. Report this at $RELEASES."

    install_appimage "$SRC" "$EXPECTED"
  else
    # The unsigned path: the digest is all this host can check, and it only
    # rules out a mangled transfer. Announced, never silent — an installer that
    # quietly drops from "signature verified" to "not corrupt" has lied by
    # omission about what it just proved.
    say "no signature check on this host ($SIG_MISSING not installed): falling back to the published sha256, which catches a corrupt or truncated download but NOT a tampered one — the digest sits on the same release, same origin and same TLS session as the binary it describes. Install minisign and re-run to have the release signature verified instead."
    say "downloading $ASSET"
    fetch "$BASE/$ASSET" "$TMP/$ASSET" ||
      fail "could not download $BASE/$ASSET. Check the network and re-run, or grab it by hand from $RELEASES/tag/$TAG."

    ACTUAL=$(sha256_of "$TMP/$ASSET")
    [ "$ACTUAL" = "$EXPECTED" ] ||
      fail "checksum mismatch for $ASSET — expected $EXPECTED, got $ACTUAL. Nothing was installed. Re-run to retry a truncated download; if it persists, report it at $RELEASES."
    say "$ASSET matches $SUM_ASSET (an intact download, not a proof of origin)"

    install_appimage "$TMP/$ASSET"
  fi

  if fuse_ready; then
    EXEC_ARGS=""
  else
    EXEC_ARGS=" --appimage-extract-and-run"
    say "no usable FUSE here (/dev/fuse plus fusermount/fusermount3), so the AppImage cannot self-mount; falling back to --appimage-extract-and-run, which unpacks to a temp directory on every start. Installing your distribution's fuse package (fuse3 / libfuse2) and re-running this installer restores the faster path."
  fi

  # Best effort, never fatal: --appimage-extract is handled by the runtime
  # itself and needs no FUSE, so the launcher entry can carry the real icon.
  # A failure here costs a generic icon and nothing else.
  if [ "$INSTALLED_NEW" = true ] || [ ! -f "$ICON_PATH" ]; then
    if (cd "$TMP" && "$BIN_PATH" --appimage-extract \
      "usr/share/icons/hicolor/256x256/apps/deco.png" > /dev/null 2>&1) &&
      [ -f "$TMP/squashfs-root/usr/share/icons/hicolor/256x256/apps/deco.png" ]; then
      mkdir -p "$ICON_DIR"
      cp "$TMP/squashfs-root/usr/share/icons/hicolor/256x256/apps/deco.png" \
        "$ICON_PATH"
    fi
  fi

  # Rewritten every run: it is a few bytes, it repairs a half-written entry,
  # and Exec has to track whichever FUSE verdict this host just produced. The
  # program is double-quoted because the desktop-entry spec splits Exec on
  # whitespace, and $HOME may contain a space.
  mkdir -p "$DESKTOP_DIR"
  cat > "$DESKTOP_PATH" << DESKTOP_ENTRY
[Desktop Entry]
Type=Application
Name=deco
GenericName=MCP control plane
Comment=deco studio
Exec="$BIN_PATH"$EXEC_ARGS
Icon=deco-studio
Terminal=false
Categories=Development;Network;
StartupWMClass=deco
DESKTOP_ENTRY
  if have update-desktop-database; then
    update-desktop-database "$DESKTOP_DIR" > /dev/null 2>&1 || true
  fi

  case ":${PATH:-}:" in
    *":$BIN_DIR:"*) ;;
    *)
      say "note: $BIN_DIR is not on your PATH. To launch from a terminal, add this to your shell profile:"
      say "  export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac

  say "done — deco $VERSION is installed and listed in your application launcher."
  say "run it with: $BIN_PATH$EXEC_ARGS"
  say "upgrade later by re-running this installer."
}

case "$(uname -s)" in
  Darwin) install_macos ;;
  Linux) install_linux ;;
  *)
    fail "unsupported operating system: $(uname -s). deco studio ships a macOS (Apple Silicon) app and a Linux x86_64 AppImage — see $RELEASES."
    ;;
esac

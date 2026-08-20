# The Homebrew cask for the deco desktop app. This repository doubles as the
# tap:
#
#   brew tap decocms/studio https://github.com/decocms/studio
#   brew install --cask deco-studio
#
# `version` and `sha256` are maintained by .github/workflows/release-native.yaml,
# which rewrites them after each desktop release's assets are published —
# never edit them by hand.
#
# `sha256 :no_check` is the NOT-YET-RELEASED sentinel: while it is set, the
# `version` below is a placeholder and its download URL does not exist, so
# `brew install` will 404. The first desktop release (which cuts automatically
# once a version bump lands on main) rewrites both to real values and the tap
# becomes installable. Until then this file only reserves the cask name.
cask "deco-studio" do
  version "4.252.1"
  sha256 "211a3f3e4f9711bbff88cff7006a4f2a0bbb8d7c204a7bf5456303111c30a7e5"

  url "https://github.com/decocms/studio/releases/download/native-v#{version}/deco-#{version}-aarch64.zip"
  name "deco studio"
  desc "Open-source control plane for MCP traffic — desktop app"
  homepage "https://github.com/decocms/studio"

  depends_on arch: :arm64
  depends_on macos: :big_sur
  depends_on formula: "git"
  depends_on formula: "ripgrep"

  # The app updates itself (Tauri updater — see
  # apps/native/docs/native-updater-plan.md). Without this, `brew upgrade`
  # compares the tap version against its install receipt and REINSTALLS
  # (downgrades) over a self-updated app. `--greedy` still overwrites, which
  # is fine (the app self-updates back) and is the documented break-glass
  # recovery path if the updater signing key is ever lost.
  auto_updates true

  app "deco.app"

  # Drop this block once releases are signed + notarized (the six APPLE_*
  # secrets in release-native.yaml) — at that point Gatekeeper passes and
  # the quarantine flag no longer needs clearing.
  caveats <<~EOS
    deco studio is not yet signed/notarized, so macOS reports the app as
    "damaged" on first launch. Clear the quarantine flag and relaunch:
      xattr -dr com.apple.quarantine "#{appdir}/deco.app"
  EOS

  zap trash: [
    "~/Library/Application Support/com.decocms.studio",
    "~/Library/Caches/com.decocms.studio",
    "~/Library/Preferences/com.decocms.studio.plist",
    "~/Library/WebKit/com.decocms.studio",
  ]
end

# The Homebrew cask for the deco desktop app. This repository doubles as the
# tap:
#
#   brew tap decocms/studio https://github.com/decocms/studio
#   brew install --cask deco
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
cask "deco" do
  version "0.1.0"
  sha256 :no_check

  url "https://github.com/decocms/studio/releases/download/native-v#{version}/deco-#{version}-aarch64.zip"
  name "deco"
  desc "Open-source control plane for MCP traffic — desktop app"
  homepage "https://github.com/decocms/studio"

  depends_on arch: :arm64
  depends_on macos: :big_sur

  app "deco.app"

  zap trash: [
    "~/Library/Application Support/com.decocms.studio",
    "~/Library/Caches/com.decocms.studio",
    "~/Library/Preferences/com.decocms.studio.plist",
    "~/Library/WebKit/com.decocms.studio",
  ]
end

# Kept so brew explains the discontinuation and `brew uninstall --zap` still works.
cask "deco-studio" do
  version "4.490.1"
  sha256 "787cc682118cef4506293ae70f1d2d3a32466a0a11f8b64e29846092c8906e55"

  url "https://github.com/decocms/studio/releases/download/native-v#{version}/deco-#{version}-aarch64.zip"
  name "deco studio"
  desc "Discontinued desktop app for deco studio"
  homepage "https://studio.decocms.com/"

  disable! date:    "2026-10-15",
           because: "is discontinued; use deco studio in your browser at https://studio.decocms.com"

  depends_on arch: :arm64
  depends_on :macos

  app "deco.app"

  zap trash: [
    "~/Library/Application Support/com.decocms.studio",
    "~/Library/Caches/com.decocms.studio",
    "~/Library/Preferences/com.decocms.studio.plist",
    "~/Library/WebKit/com.decocms.studio",
  ]
end

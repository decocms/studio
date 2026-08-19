import { describe, expect, it } from "bun:test";
import {
  appImageDownloadUrl,
  copyToClipboard,
} from "./download-app-dialog.tsx";

describe("copyToClipboard", () => {
  it("resolves true when writeText succeeds", async () => {
    const ok = await copyToClipboard(
      { writeText: () => Promise.resolve() },
      "curl -fsSL https://example.com/install.sh | sh",
    );
    expect(ok).toBe(true);
  });

  it("resolves false instead of throwing when clipboard is undefined", async () => {
    const ok = await copyToClipboard(undefined, "command");
    expect(ok).toBe(false);
  });

  it("resolves false instead of rejecting when writeText is denied", async () => {
    const ok = await copyToClipboard(
      { writeText: () => Promise.reject(new Error("denied")) },
      "command",
    );
    expect(ok).toBe(false);
  });
});

// The asset name is a cross-area contract: the release workflow renames the
// bundler output to it, the updater manifest's PLATFORM_ASSETS derives from it,
// and this link points at it. Drift must be a deliberate edit here, not a
// silent 404 for every Linux visitor.
describe("appImageDownloadUrl", () => {
  it("points at the native-v tag's x86_64 AppImage asset", () => {
    expect(appImageDownloadUrl("4.151.0")).toBe(
      "https://github.com/decocms/studio/releases/download/native-v4.151.0/deco-4.151.0-linux-x86_64.AppImage",
    );
  });

  it("tags the release with the native-v prefix", () => {
    expect(appImageDownloadUrl("1.2.3")).toContain(
      "/releases/download/native-v1.2.3/",
    );
  });

  it("names the asset with the -linux-x86_64.AppImage suffix", () => {
    expect(
      appImageDownloadUrl("1.2.3").endsWith("-linux-x86_64.AppImage"),
    ).toBe(true);
  });

  it("never resolves through releases/latest", () => {
    expect(appImageDownloadUrl("1.2.3")).not.toContain("latest");
  });
});

import { describe, expect, test } from "bun:test";
import { join, resolve, sep } from "node:path";
import { resolveBootSmokePaths } from "./boot-smoke-paths";
import { resolveSmokeTarget } from "./boot-smoke-target";

const DESKTOP_DIR = resolve("apps/native");

/** The three patterns the smoke swept for before Linux existed. */
const LEGACY_SWEEP_PATTERNS = [
  "target/(debug|release)/deco([[:space:]]|$)",
  "target/(debug|release)/bundle/macos/deco\\.app/Contents/MacOS/deco([[:space:]]|$)",
  "target/(debug|release)/local-api([[:space:]]|$)",
];

describe("resolveSmokeTarget(darwin)", () => {
  const target = resolveSmokeTarget("darwin", DESKTOP_DIR);

  test("keeps the exact values the smoke hardcoded before Linux existed", () => {
    expect(target.bundlesArg).toEqual(["--bundles", "app"]);
    expect(target.bundleDir).toBe(
      join(DESKTOP_DIR, "target/release/bundle/macos"),
    );
    expect(target.launchedBinaryRelPath).toBe("Contents/MacOS/deco");
    // macOS spawns the binary itself — no wrapper, unchanged from before Linux.
    expect(target.launchEntryRelPath).toBe(target.launchedBinaryRelPath);
    expect(
      join(target.bundleDir, "deco.app", target.launchedBinaryRelPath),
    ).toBe(
      join(
        DESKTOP_DIR,
        "target/release/bundle/macos/deco.app/Contents/MacOS/deco",
      ),
    );
    expect(target.sweepPatterns).toEqual(LEGACY_SWEEP_PATTERNS);
  });

  test("identifies the .app and nothing else", () => {
    expect(target.isBundleArtifact("deco.app")).toBe(true);
    expect(target.isBundleArtifact("deco")).toBe(false);
    expect(target.isBundleArtifact("deco_4.152.0_amd64.AppImage")).toBe(false);
  });

  test("asserts no sidecar staging — macOS never gated externalBin", () => {
    expect(target.requiredSidecars).toEqual([]);
  });
});

describe("resolveSmokeTarget(linux)", () => {
  const target = resolveSmokeTarget("linux", DESKTOP_DIR);

  test("bundles and launches the AppImage", () => {
    expect(target.bundlesArg).toEqual(["--bundles", "appimage"]);
    expect(target.bundleDir).toBe(
      join(DESKTOP_DIR, "target/release/bundle/appimage"),
    );
    expect(target.launchedBinaryRelPath).toBe("squashfs-root/usr/bin/deco");
    // Spawning usr/bin/deco directly boots Rust but kills WebKitGTK, which
    // finds WebKitNetworkProcess only via the env AppRun exports.
    expect(target.launchEntryRelPath).toBe("squashfs-root/AppRun");
  });

  test("identifies a versioned AppImage, not the AppDir beside it", () => {
    expect(target.isBundleArtifact("deco_4.152.0_amd64.AppImage")).toBe(true);
    expect(target.isBundleArtifact("deco_0.1.0_amd64.AppImage")).toBe(true);
    expect(target.isBundleArtifact("deco.AppDir")).toBe(false);
    expect(target.isBundleArtifact("deco.AppImage")).toBe(false);
    expect(target.isBundleArtifact("deco_0.1.0_amd64.AppImage.tar.gz")).toBe(
      false,
    );
    expect(target.isBundleArtifact("../deco_0.1.0_amd64.AppImage")).toBe(false);
  });

  test("gates the rclone sidecar staged next to the inner binary", () => {
    expect(target.requiredSidecars).toEqual(["rclone"]);
  });

  test("keeps every legacy sweep pattern and adds the extraction one", () => {
    for (const pattern of LEGACY_SWEEP_PATTERNS) {
      expect(target.sweepPatterns).toContain(pattern);
    }
    expect(target.sweepPatterns).toContain(
      "squashfs-root/usr/bin/deco([[:space:]]|$)",
    );
  });
});

describe("launch roots", () => {
  const tempRoot = resolve("boot-smoke-target-fixtures");
  const smokeRoot = join(tempRoot, "desktop-boot-smoke-a1B2c3");

  test("the AppImage extraction path stays under the validated smoke root", () => {
    const { root } = resolveBootSmokePaths(smokeRoot, tempRoot);
    const bin = join(
      root,
      resolveSmokeTarget("linux", DESKTOP_DIR).launchedBinaryRelPath,
    );
    expect(bin.startsWith(root + sep)).toBe(true);
    expect(bin).toBe(join(smokeRoot, "squashfs-root/usr/bin/deco"));
    const entry = join(
      root,
      resolveSmokeTarget("linux", DESKTOP_DIR).launchEntryRelPath,
    );
    expect(entry.startsWith(root + sep)).toBe(true);
    expect(entry).toBe(join(smokeRoot, "squashfs-root/AppRun"));
  });
});

test("refuses to smoke an unsupported platform", () => {
  expect(() => resolveSmokeTarget("win32", DESKTOP_DIR)).toThrow(
    "boot smoke does not support platform: win32",
  );
  expect(() => resolveSmokeTarget("", DESKTOP_DIR)).toThrow(
    "boot smoke does not support platform",
  );
});

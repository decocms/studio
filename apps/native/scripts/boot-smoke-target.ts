import { join } from "node:path";

export const APP_BINARY_NAME = "deco";

/**
 * Pinned so the boot smoke validates a bundle produced by the SAME bundler the
 * release pipeline uses (`.github/workflows/release-native.yaml`). The Linux
 * updater's version-pairing check reads the AppImage member name
 * `{product}_{version}_{arch}`, which only the bundler's version guarantees.
 */
export const TAURI_CLI_VERSION = "2.11.4";

/** Where `--appimage-extract` unpacks, relative to the cwd it runs in. */
const APPIMAGE_EXTRACT_DIR = "squashfs-root";

/**
 * `pgrep -f` patterns for the desktop binaries. Each one ends the binary name
 * at a word boundary (whitespace before args, or end of the command line).
 * Without it, the bare `deco` prefix also matches sibling target binaries —
 * `decocms-keychain-helper`, a dev-run `deco`-prefixed build — and a process
 * spawning during the smoke window gets misreported as a leaked orphan.
 */
const SWEEP_PATTERNS = [
  "target/(debug|release)/deco([[:space:]]|$)",
  "target/(debug|release)/bundle/macos/deco\\.app/Contents/MacOS/deco([[:space:]]|$)",
  "target/(debug|release)/local-api([[:space:]]|$)",
];

/** Matches `deco_4.152.0_amd64.AppImage`, never the `deco.AppDir` beside it. */
const APPIMAGE_ARTIFACT = /^deco_[^_/]+_amd64\.AppImage$/;

export interface SmokeTarget {
  platform: "darwin" | "linux";
  /** Appended to `tauri build`. */
  bundlesArg: string[];
  /** Absolute directory the bundler writes the shipped artifact into. */
  bundleDir: string;
  /** True for the one entry of `bundleDir` that IS the shipped artifact. */
  isBundleArtifact: (name: string) => boolean;
  /**
   * The launched binary, relative to the launch root — which is the bundle
   * artifact itself on macOS (a directory) and the AppImage extraction
   * directory on Linux (the artifact is a single file).
   */
  launchedBinaryRelPath: string;
  /**
   * `externalBin` sidecars that must sit beside the launched binary. Empty on
   * macOS: the smoke has never asserted staging there, and adding it would
   * change what the macOS smoke gates.
   */
  requiredSidecars: string[];
  sweepPatterns: string[];
}

/**
 * Per-platform facts about the bundle the boot smoke gates: what to ask the
 * bundler for, where the artifact lands, how it is launched, and which process
 * patterns count as ours during the orphan sweep.
 *
 * Pure, so the macOS values — which must stay exactly what the smoke used
 * before Linux existed — are pinned by a unit test.
 */
export function resolveSmokeTarget(
  platform: string,
  desktopDir: string,
): SmokeTarget {
  if (platform === "darwin") {
    return {
      platform: "darwin",
      bundlesArg: ["--bundles", "app"],
      bundleDir: join(desktopDir, "target", "release", "bundle", "macos"),
      isBundleArtifact: (name) => name === `${APP_BINARY_NAME}.app`,
      launchedBinaryRelPath: join("Contents", "MacOS", APP_BINARY_NAME),
      requiredSidecars: [],
      sweepPatterns: [...SWEEP_PATTERNS],
    };
  }
  if (platform === "linux") {
    return {
      platform: "linux",
      bundlesArg: ["--bundles", "appimage"],
      bundleDir: join(desktopDir, "target", "release", "bundle", "appimage"),
      isBundleArtifact: (name) => APPIMAGE_ARTIFACT.test(name),
      launchedBinaryRelPath: join(
        APPIMAGE_EXTRACT_DIR,
        "usr",
        "bin",
        APP_BINARY_NAME,
      ),
      requiredSidecars: ["rclone"],
      sweepPatterns: [
        ...SWEEP_PATTERNS,
        `${APPIMAGE_EXTRACT_DIR}/usr/bin/${APP_BINARY_NAME}([[:space:]]|$)`,
      ],
    };
  }
  throw new Error(`boot smoke does not support platform: ${platform}`);
}

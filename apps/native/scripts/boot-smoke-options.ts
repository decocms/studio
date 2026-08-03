export type BootSmokeBundleMode =
  | "ensure-fresh"
  | "force-rebuild"
  | "require-existing";

type BootSmokeBundleAction =
  | "build"
  | "check-freshness"
  | "use-existing"
  | "reject-missing";

interface BootSmokeOptions {
  bundleMode: BootSmokeBundleMode;
}

const REBUILD_FLAG = "--rebuild";
const REQUIRE_EXISTING_BUNDLE_FLAG = "--require-existing-bundle";
const SUPPORTED_FLAGS = new Set([REBUILD_FLAG, REQUIRE_EXISTING_BUNDLE_FLAG]);

/**
 * Parses the boot smoke's small CLI surface independently from any filesystem
 * or process work, so CI-only bundle selection cannot accidentally trigger a
 * build before invalid arguments are rejected.
 */
export function parseBootSmokeOptions(args: string[]): BootSmokeOptions {
  const unsupported = args.find((arg) => !SUPPORTED_FLAGS.has(arg));
  if (unsupported) {
    throw new Error(`unsupported boot-smoke argument: ${unsupported}`);
  }

  const forceRebuild = args.includes(REBUILD_FLAG);
  const requireExisting = args.includes(REQUIRE_EXISTING_BUNDLE_FLAG);
  if (forceRebuild && requireExisting) {
    throw new Error(
      `${REBUILD_FLAG} and ${REQUIRE_EXISTING_BUNDLE_FLAG} cannot be used together`,
    );
  }

  if (requireExisting) return { bundleMode: "require-existing" };
  if (forceRebuild) return { bundleMode: "force-rebuild" };
  return { bundleMode: "ensure-fresh" };
}

/**
 * Chooses whether boot-smoke may build before any filesystem walk or process
 * spawn. In particular, CI's require-existing mode can only use the artifact
 * it was handed or reject it as missing; it can never select a build.
 */
export function resolveBootSmokeBundleAction(
  bundleMode: BootSmokeBundleMode,
  bundleExists: boolean,
): BootSmokeBundleAction {
  if (bundleMode === "require-existing") {
    return bundleExists ? "use-existing" : "reject-missing";
  }
  if (bundleMode === "force-rebuild" || !bundleExists) return "build";
  return "check-freshness";
}

import { basename, dirname, join, resolve } from "node:path";

export const BOOT_SMOKE_TEMP_PREFIX = "desktop-boot-smoke-";
const APP_DATA_DIR_NAME = "app-data";
const REPORT_FILE_NAME = "selftest-report.json";

export interface BootSmokePaths {
  root: string;
  appDataDir: string;
  reportFile: string;
}

/**
 * Validates the directory returned by `mkdtemp(<tmp>/<prefix>)` before it can
 * become either the native app's self-test data root or an `rm -r` target.
 * Keeping this pure makes the destructive boundary independently testable.
 */
export function resolveBootSmokePaths(
  candidate: string,
  tempRoot: string,
): BootSmokePaths {
  const root = resolve(candidate);
  const expectedParent = resolve(tempRoot);
  const name = basename(root);

  if (
    dirname(root) !== expectedParent ||
    !name.startsWith(BOOT_SMOKE_TEMP_PREFIX) ||
    name.length === BOOT_SMOKE_TEMP_PREFIX.length
  ) {
    throw new Error(
      `refusing unsafe boot-smoke directory outside ${expectedParent}: ${root}`,
    );
  }

  return {
    root,
    appDataDir: join(root, APP_DATA_DIR_NAME),
    reportFile: join(root, REPORT_FILE_NAME),
  };
}

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { resolveBootSmokePaths } from "./boot-smoke-paths";

describe("resolveBootSmokePaths", () => {
  const tempRoot = resolve("boot-smoke-path-fixtures");
  const smokeRoot = join(tempRoot, "desktop-boot-smoke-a1B2c3");

  test("derives all smoke-owned paths under a validated temporary root", () => {
    expect(resolveBootSmokePaths(smokeRoot, tempRoot)).toEqual({
      root: smokeRoot,
      appDataDir: join(smokeRoot, "app-data"),
      reportFile: join(smokeRoot, "selftest-report.json"),
    });
  });

  test("rejects the production app-data directory", () => {
    expect(() =>
      resolveBootSmokePaths(
        resolve("Library/Application Support/com.decocms.studio"),
        tempRoot,
      ),
    ).toThrow("refusing unsafe boot-smoke directory");
  });

  test("rejects a nested or escaped prefix-shaped path", () => {
    expect(() =>
      resolveBootSmokePaths(
        join(tempRoot, "other", "desktop-boot-smoke-a1B2c3"),
        tempRoot,
      ),
    ).toThrow("refusing unsafe boot-smoke directory");
    expect(() =>
      resolveBootSmokePaths(join(smokeRoot, "..", "outside"), tempRoot),
    ).toThrow("refusing unsafe boot-smoke directory");
  });

  test("rejects the bare prefix without mkdtemp's unique suffix", () => {
    expect(() =>
      resolveBootSmokePaths(join(tempRoot, "desktop-boot-smoke-"), tempRoot),
    ).toThrow("refusing unsafe boot-smoke directory");
  });
});

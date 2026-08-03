import { describe, expect, test } from "bun:test";
import {
  parseBootSmokeOptions,
  resolveBootSmokeBundleAction,
} from "./boot-smoke-options";

describe("parseBootSmokeOptions", () => {
  test("keeps freshness-aware local behavior by default", () => {
    expect(parseBootSmokeOptions([])).toEqual({
      bundleMode: "ensure-fresh",
    });
  });

  test("selects a forced rebuild", () => {
    expect(parseBootSmokeOptions(["--rebuild"])).toEqual({
      bundleMode: "force-rebuild",
    });
  });

  test("selects the existing-bundle-only mode", () => {
    expect(parseBootSmokeOptions(["--require-existing-bundle"])).toEqual({
      bundleMode: "require-existing",
    });
  });

  test("rejects conflicting bundle modes", () => {
    expect(() =>
      parseBootSmokeOptions(["--rebuild", "--require-existing-bundle"]),
    ).toThrow(
      "--rebuild and --require-existing-bundle cannot be used together",
    );
  });

  test("rejects unsupported arguments", () => {
    expect(() => parseBootSmokeOptions(["--unknown"])).toThrow(
      "unsupported boot-smoke argument: --unknown",
    );
  });
});

describe("resolveBootSmokeBundleAction", () => {
  test("never builds when CI requires the existing bundle", () => {
    expect(resolveBootSmokeBundleAction("require-existing", true)).toBe(
      "use-existing",
    );
    expect(resolveBootSmokeBundleAction("require-existing", false)).toBe(
      "reject-missing",
    );
  });

  test("always builds when a rebuild is forced", () => {
    expect(resolveBootSmokeBundleAction("force-rebuild", true)).toBe("build");
    expect(resolveBootSmokeBundleAction("force-rebuild", false)).toBe("build");
  });

  test("checks freshness only when the default mode finds a bundle", () => {
    expect(resolveBootSmokeBundleAction("ensure-fresh", true)).toBe(
      "check-freshness",
    );
    expect(resolveBootSmokeBundleAction("ensure-fresh", false)).toBe("build");
  });
});

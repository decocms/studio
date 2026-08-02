import { describe, expect, test } from "bun:test";
import { shouldBlockHostedLegacyDispatch } from "./hosted-runtime-guard";

describe("hosted terminal-only runtime guard", () => {
  test("blocks every non-Decopilot harness from hosted legacy dispatch", () => {
    for (const harnessId of [
      "claude-code",
      "codex",
      "opencode",
      "unknown-future-harness",
    ]) {
      expect(
        shouldBlockHostedLegacyDispatch({
          isDesktopApp: false,
          harnessId,
        }),
      ).toBeTrue();
    }
  });

  test("leaves terminal-only harnesses available to the native runtime", () => {
    for (const harnessId of ["claude-code", "codex", "opencode"]) {
      expect(
        shouldBlockHostedLegacyDispatch({
          isDesktopApp: true,
          harnessId,
        }),
      ).toBeFalse();
    }
  });

  test("allows only Decopilot or an unpinned thread on hosted web", () => {
    for (const harnessId of [null, undefined, "decopilot"]) {
      expect(
        shouldBlockHostedLegacyDispatch({
          isDesktopApp: false,
          harnessId,
        }),
      ).toBeFalse();
    }
  });
});

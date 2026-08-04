import { describe, expect, test } from "bun:test";
import { shouldBlockHostedRuntime } from "./hosted-runtime-guard";

describe("hosted runtime guard", () => {
  test("blocks every non-Decopilot harness from hosted dispatch", () => {
    for (const harnessId of [
      "claude-code",
      "codex",
      "opencode",
      "unknown-future-harness",
    ]) {
      expect(
        shouldBlockHostedRuntime({
          isDesktopApp: false,
          harnessId,
          sandboxProviderKind: "user-desktop",
        }),
      ).toBeTrue();
    }
  });

  test("leaves terminal-only harnesses available to the native runtime", () => {
    for (const harnessId of ["claude-code", "codex", "opencode"]) {
      expect(
        shouldBlockHostedRuntime({
          isDesktopApp: true,
          harnessId,
          sandboxProviderKind: "user-desktop",
        }),
      ).toBeFalse();
    }
  });

  test("allows only valid pre-pin tuples and the exact hosted tuple", () => {
    for (const [harnessId, sandboxProviderKind] of [
      [null, null],
      [undefined, undefined],
      [null, "agent-sandbox"],
      [undefined, "agent-sandbox"],
      ["decopilot", "agent-sandbox"],
    ] as const) {
      expect(
        shouldBlockHostedRuntime({
          isDesktopApp: false,
          harnessId,
          sandboxProviderKind,
        }),
      ).toBeFalse();
    }
  });

  test("blocks partial, retired, and unknown hosted tuples", () => {
    for (const [harnessId, sandboxProviderKind] of [
      ["decopilot", null],
      ["decopilot", undefined],
      ["decopilot", "user-desktop"],
      ["decopilot", "future-sandbox"],
      [null, "user-desktop"],
      [null, "cluster"],
    ] as const) {
      expect(
        shouldBlockHostedRuntime({
          isDesktopApp: false,
          harnessId,
          sandboxProviderKind,
        }),
      ).toBeTrue();
    }
  });
});

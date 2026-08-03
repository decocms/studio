import { describe, expect, test } from "bun:test";
import { shouldBlockHostedRuntime } from "./hosted-runtime-guard";

describe("hosted terminal-only runtime guard", () => {
  test("blocks every non-Decopilot harness from hosted legacy dispatch", () => {
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

  test("allows Decopilot and unpinned hosted runtimes on the web", () => {
    for (const [harnessId, sandboxProviderKind] of [
      [null, null],
      [undefined, undefined],
      ["decopilot", null],
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

  test("blocks retired or unknown sandbox runtimes on hosted web", () => {
    for (const sandboxProviderKind of ["user-desktop", "future-sandbox"]) {
      expect(
        shouldBlockHostedRuntime({
          isDesktopApp: false,
          harnessId: "decopilot",
          sandboxProviderKind,
        }),
      ).toBeTrue();
    }
  });
});

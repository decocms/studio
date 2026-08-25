import { describe, expect, test } from "bun:test";
import {
  isBatchHarness,
  shouldBlockHostedRuntime,
} from "./hosted-runtime-guard";

describe("isBatchHarness", () => {
  test("treats claude-code as a batch job and Decopilot as a stream", () => {
    expect(isBatchHarness("claude-code")).toBeTrue();
    // Decopilot streams token-by-token; batching it would freeze the chat
    // until the turn finished.
    expect(isBatchHarness("decopilot")).toBeFalse();
    expect(isBatchHarness(null)).toBeFalse();
    expect(isBatchHarness(undefined)).toBeFalse();
  });
});

describe("hosted terminal-only runtime guard", () => {
  test("blocks non-hosted harnesses on hosted web", () => {
    for (const harnessId of ["codex", "opencode", "unknown-future-harness"]) {
      expect(
        shouldBlockHostedRuntime({
          isDesktopApp: false,
          harnessId,
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
        }),
      ).toBeFalse();
    }
  });

  test("allows hosted harnesses and unpinned threads on the web", () => {
    for (const harnessId of [
      null,
      undefined,
      "decopilot",
      // claude-code runs IN the hosted sandbox — the chat must render on the
      // web. Regression: this rendered "This chat isn't available on the web".
      "claude-code",
    ] as const) {
      expect(
        shouldBlockHostedRuntime({
          isDesktopApp: false,
          harnessId,
        }),
      ).toBeFalse();
    }
  });

  test("ignores retired provider values", () => {
    const dirtyThread = {
      isDesktopApp: false,
      harnessId: "decopilot",
      sandboxProviderKind: "local-api",
    };
    expect(shouldBlockHostedRuntime(dirtyThread)).toBeFalse();
  });
});

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
  test("blocks every desktop-pinned harness from hosted legacy dispatch", () => {
    for (const harnessId of [
      // Pinned to the retired desktop sandbox, this is the NATIVE coding agent,
      // not the sandbox-hosted `claude-code` the hosted dispatcher runs.
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

  test("blocks non-hosted harnesses regardless of sandbox pin", () => {
    for (const harnessId of ["codex", "opencode", "unknown-future-harness"]) {
      for (const sandboxProviderKind of [null, "agent-sandbox"] as const) {
        expect(
          shouldBlockHostedRuntime({
            isDesktopApp: false,
            harnessId,
            sandboxProviderKind,
          }),
        ).toBeTrue();
      }
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

  test("allows every sandbox-hosted harness and unpinned runtimes on the web", () => {
    for (const [harnessId, sandboxProviderKind] of [
      [null, null],
      [undefined, undefined],
      ["decopilot", null],
      ["decopilot", "agent-sandbox"],
      // claude-code runs IN the hosted sandbox — the chat must render on the
      // web. Regression: this rendered "This chat isn't available on the web".
      ["claude-code", "agent-sandbox"],
      // Pinned before the first dispatch wrote the sandbox kind.
      ["claude-code", null],
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

  test("keeps legacy Decopilot desktop pins readable as hosted", () => {
    expect(
      shouldBlockHostedRuntime({
        isDesktopApp: false,
        harnessId: "decopilot",
        sandboxProviderKind: "user-desktop",
      }),
    ).toBeFalse();
  });

  test("blocks unknown sandbox runtimes on hosted web", () => {
    expect(
      shouldBlockHostedRuntime({
        isDesktopApp: false,
        harnessId: "decopilot",
        sandboxProviderKind: "future-sandbox",
      }),
    ).toBeTrue();
  });
});

import { describe, expect, test } from "bun:test";
import { shouldBlockHostedRuntime } from "./hosted-runtime-guard";

describe("hosted runtime guard", () => {
  test("blocks harnesses the hosted dispatcher cannot run", () => {
    for (const harnessId of ["codex", "opencode", "unknown-future-harness"]) {
      expect(shouldBlockHostedRuntime(harnessId)).toBeTrue();
    }
  });

  test("allows hosted harnesses and unpinned threads", () => {
    for (const harnessId of [
      null,
      undefined,
      "decopilot",
      // claude-code runs IN the hosted sandbox — the chat must render on the
      // web. Regression: this rendered "This chat isn't available on the web".
      "claude-code",
    ] as const) {
      expect(shouldBlockHostedRuntime(harnessId)).toBeFalse();
    }
  });
});

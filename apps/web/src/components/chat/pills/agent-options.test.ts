import { describe, expect, test } from "bun:test";

import {
  AGENT_OPTION_HARNESSES,
  resolveNativeAgentOption,
} from "./agent-options";
describe("AGENT_OPTION_HARNESSES", () => {
  test("keeps one unique harness per option", () => {
    expect(new Set(Object.values(AGENT_OPTION_HARNESSES)).size).toBe(
      Object.keys(AGENT_OPTION_HARNESSES).length,
    );
  });
});

describe("resolveNativeAgentOption", () => {
  test("does not turn an unselected native chat into cloud Decopilot", () => {
    for (const pendingOption of [null, "decopilot"] as const) {
      expect(
        resolveNativeAgentOption({
          pendingOption,
          lockedHarness: null,
        }),
      ).toBeNull();
    }
  });
  test("preserves an explicit local choice", () => {
    expect(
      resolveNativeAgentOption({
        pendingOption: "codex-desktop",
        lockedHarness: null,
      }),
    ).toBe("codex-desktop");

    expect(
      resolveNativeAgentOption({
        pendingOption: "opencode-desktop",
        lockedHarness: null,
      }),
    ).toBe("opencode-desktop");
  });

  test("a locked local harness wins without requiring its sandbox tuple", () => {
    expect(
      resolveNativeAgentOption({
        pendingOption: "codex-desktop",
        lockedHarness: "claude-code",
      }),
    ).toBe("claude-code-desktop");

    expect(
      resolveNativeAgentOption({
        pendingOption: "claude-code-desktop",
        lockedHarness: "opencode",
      }),
    ).toBe("opencode-desktop");
  });
});

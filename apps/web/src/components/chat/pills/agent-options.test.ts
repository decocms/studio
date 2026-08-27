import { describe, expect, test } from "bun:test";

import {
  AGENT_OPTION_HARNESSES,
  resolveNativeAgentOption,
} from "./agent-options";

describe("native agent options", () => {
  test("exposes the harness used to launch each option", () => {
    expect(AGENT_OPTION_HARNESSES).toEqual({
      "claude-code-desktop": "claude-code",
      "codex-desktop": "codex",
      "opencode-desktop": "opencode",
    });
  });
});

describe("resolveNativeAgentOption", () => {
  test("keeps an unselected native chat unselected", () => {
    expect(
      resolveNativeAgentOption({
        pendingOption: null,
        lockedHarness: null,
      }),
    ).toBeNull();
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

  test("a locked native harness wins", () => {
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

  test("non-native locked harnesses are not native options", () => {
    for (const lockedHarness of ["decopilot", "future"] as const) {
      expect(
        resolveNativeAgentOption({
          pendingOption: "codex-desktop",
          lockedHarness,
        }),
      ).toBeNull();
    }
  });
});

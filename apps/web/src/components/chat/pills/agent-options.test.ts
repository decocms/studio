import { describe, expect, test } from "bun:test";

import {
  AGENT_OPTION_PINS,
  type AgentOption,
  type AgentPins,
  agentOptionFor,
  resolveNativeAgentOption,
} from "./agent-options";

describe("agentOptionFor", () => {
  test("maps decopilot harness with agent-sandbox sandbox to decopilot option", () => {
    expect(agentOptionFor("decopilot", "agent-sandbox")).toBe("decopilot");
  });

  test("normalizes legacy cluster sandbox to decopilot option", () => {
    expect(agentOptionFor("decopilot", "cluster")).toBe("decopilot");
  });

  test("maps retired local Decopilot pins to hosted Decopilot", () => {
    expect(agentOptionFor("decopilot", "user-desktop")).toBe("decopilot");
  });

  test("maps legacy decopilot harness with null sandbox to decopilot option", () => {
    expect(agentOptionFor("decopilot", null)).toBe("decopilot");
  });

  test("maps claude-code + user-desktop to claude-code-desktop", () => {
    expect(agentOptionFor("claude-code", "user-desktop")).toBe(
      "claude-code-desktop",
    );
  });

  test("maps codex + user-desktop to codex-desktop", () => {
    expect(agentOptionFor("codex", "user-desktop")).toBe("codex-desktop");
  });

  test("returns null for unknown harness", () => {
    // @ts-expect-error — deliberately passing an out-of-union value
    expect(agentOptionFor("unknown-harness", null)).toBeNull();
  });

  test("returns null for null harness", () => {
    expect(agentOptionFor(null, "user-desktop")).toBeNull();
  });

  test("round-trips against AGENT_OPTION_PINS", () => {
    for (const [option, pins] of Object.entries(AGENT_OPTION_PINS) as [
      AgentOption,
      AgentPins,
    ][]) {
      expect(agentOptionFor(pins.harness, pins.sandbox)).toBe(option);
    }
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
  });

  test("a locked local harness wins without requiring its sandbox tuple", () => {
    expect(
      resolveNativeAgentOption({
        pendingOption: "codex-desktop",
        lockedHarness: "claude-code",
      }),
    ).toBe("claude-code-desktop");
  });
});

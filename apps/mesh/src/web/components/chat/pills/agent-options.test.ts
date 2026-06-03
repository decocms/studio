import { describe, expect, test } from "bun:test";

import {
  AGENT_OPTION_PINS,
  type AgentOption,
  type AgentPins,
  agentOptionFor,
} from "./agent-options";

describe("agentOptionFor", () => {
  test("maps decopilot harness with null sandbox to decopilot option", () => {
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

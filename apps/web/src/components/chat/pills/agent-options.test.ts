import { describe, expect, test } from "bun:test";

import {
  AGENT_OPTION_HARNESSES,
  type AgentOption,
  type AgentHarnessId,
  agentOptionFor,
  resolveNativeAgentOption,
} from "./agent-options";
describe("agentOptionFor", () => {
  test("maps the hosted harness to Decopilot", () => {
    expect(agentOptionFor("decopilot")).toBe("decopilot");
  });

  test("maps claude-code to claude-code-desktop", () => {
    expect(agentOptionFor("claude-code")).toBe("claude-code-desktop");
  });

  test("maps codex to codex-desktop", () => {
    expect(agentOptionFor("codex")).toBe("codex-desktop");
  });

  test("maps opencode to opencode-desktop", () => {
    expect(agentOptionFor("opencode")).toBe("opencode-desktop");
  });

  test("returns null for unknown harness", () => {
    expect(agentOptionFor("unknown-harness")).toBeNull();
  });

  test("returns null for null harness", () => {
    expect(agentOptionFor(null)).toBeNull();
  });

  test("round-trips against AGENT_OPTION_HARNESSES", () => {
    for (const [option, harness] of Object.entries(AGENT_OPTION_HARNESSES) as [
      AgentOption,
      AgentHarnessId,
    ][]) {
      expect(agentOptionFor(harness)).toBe(option);
    }
  });

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

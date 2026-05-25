import { describe, expect, it } from "bun:test";
import {
  agentModeFromOption,
  agentOptionFromMode,
  type AgentMode,
} from "./use-agent-mode";

describe("agentOptionFromMode <-> agentModeFromOption", () => {
  const cases: Array<
    [AgentMode, "decopilot" | "claude-code-desktop" | "codex-desktop"]
  > = [
    ["cloud-decopilot", "decopilot"],
    ["local-claude-code", "claude-code-desktop"],
    ["local-codex", "codex-desktop"],
  ];

  for (const [mode, option] of cases) {
    it(`maps ${mode} <-> ${option}`, () => {
      expect(agentOptionFromMode(mode)).toBe(option);
      expect(agentModeFromOption(option)).toBe(mode);
    });
  }

  it("agentModeFromOption(null) defaults to cloud-decopilot", () => {
    expect(agentModeFromOption(null)).toBe("cloud-decopilot");
  });
});

import { describe, expect, it } from "bun:test";
import {
  agentModeFromOption,
  resolveTierSubtitle,
  type AgentMode,
} from "./use-agent-mode";
import type { AgentOption } from "./pills/agent-options";

describe("agentModeFromOption", () => {
  const cases: Array<[AgentOption, AgentMode]> = [
    ["decopilot", "cloud-decopilot"],
    ["claude-code-desktop", "local-claude-code"],
    ["codex-desktop", "local-codex"],
  ];

  for (const [option, mode] of cases) {
    it(`maps ${option} → ${mode}`, () => {
      expect(agentModeFromOption(option)).toBe(mode);
    });
  }

  it("agentModeFromOption(null) defaults to cloud-decopilot", () => {
    expect(agentModeFromOption(null)).toBe("cloud-decopilot");
  });
});

describe("resolveTierSubtitle", () => {
  describe("local-claude-code: returns the versioned model label", () => {
    it("fast → Haiku 4.5", () => {
      expect(resolveTierSubtitle("local-claude-code", "fast")).toBe(
        "Haiku 4.5",
      );
    });
    it("smart → Sonnet 5", () => {
      expect(resolveTierSubtitle("local-claude-code", "smart")).toBe(
        "Sonnet 5",
      );
    });
    it("thinking → Opus 4.8 1M", () => {
      expect(resolveTierSubtitle("local-claude-code", "thinking")).toBe(
        "Opus 4.8 1M",
      );
    });
  });

  describe("local-codex: returns the versioned model label", () => {
    it("fast → GPT-5.6 Luna", () => {
      expect(resolveTierSubtitle("local-codex", "fast")).toBe("GPT-5.6 Luna");
    });
    it("smart → GPT-5.6 Terra", () => {
      expect(resolveTierSubtitle("local-codex", "smart")).toBe("GPT-5.6 Terra");
    });
    it("thinking → GPT-5.6 Sol", () => {
      expect(resolveTierSubtitle("local-codex", "thinking")).toBe(
        "GPT-5.6 Sol",
      );
    });
  });

  describe("cloud-decopilot: returns the intent description", () => {
    it("fast → Quicker responses", () => {
      expect(resolveTierSubtitle("cloud-decopilot", "fast")).toBe(
        "Quicker responses",
      );
    });
    it("smart → Balanced quality", () => {
      expect(resolveTierSubtitle("cloud-decopilot", "smart")).toBe(
        "Balanced quality",
      );
    });
    it("thinking → Deeper reasoning", () => {
      expect(resolveTierSubtitle("cloud-decopilot", "thinking")).toBe(
        "Deeper reasoning",
      );
    });
  });
});

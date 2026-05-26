import { describe, expect, it } from "bun:test";
import {
  agentModeFromOption,
  agentOptionFromMode,
  resolveTierSubtitle,
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

describe("resolveTierSubtitle", () => {
  describe("local-claude-code: returns the versioned model label", () => {
    it("fast → Haiku 4.5", () => {
      expect(resolveTierSubtitle("local-claude-code", "fast")).toBe(
        "Haiku 4.5",
      );
    });
    it("smart → Sonnet 4.6", () => {
      expect(resolveTierSubtitle("local-claude-code", "smart")).toBe(
        "Sonnet 4.6",
      );
    });
    it("thinking → Opus 4.7", () => {
      expect(resolveTierSubtitle("local-claude-code", "thinking")).toBe(
        "Opus 4.7",
      );
    });
  });

  describe("local-codex: returns the versioned model label", () => {
    it("fast → GPT-5.4 Mini", () => {
      expect(resolveTierSubtitle("local-codex", "fast")).toBe("GPT-5.4 Mini");
    });
    it("smart → GPT-5.3 Codex", () => {
      expect(resolveTierSubtitle("local-codex", "smart")).toBe("GPT-5.3 Codex");
    });
    it("thinking → GPT-5.5", () => {
      expect(resolveTierSubtitle("local-codex", "thinking")).toBe("GPT-5.5");
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

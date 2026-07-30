import { describe, expect, it } from "bun:test";
import {
  agentModeFromOption,
  resolveTierSubtitle,
  shouldUseLocalModels,
  type AgentMode,
} from "./use-agent-mode";
import type { AgentOption } from "./pills/agent-options";
import { en } from "@/i18n/en/index.ts";
import type { TFunction } from "@/i18n/use-t.ts";

const t: TFunction = (key) => en[key];
const explodingT: TFunction = () => {
  throw new Error(
    "local tier subtitles must not translate — they're model names",
  );
};

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

describe("shouldUseLocalModels", () => {
  it("keeps native on local models while runtime detection is pending", () => {
    expect(shouldUseLocalModels("cloud-decopilot", true)).toBe(true);
  });

  it("keeps cloud models on web and local models for explicit local modes", () => {
    expect(shouldUseLocalModels("cloud-decopilot", false)).toBe(false);
    expect(shouldUseLocalModels("local-claude-code", false)).toBe(true);
    expect(shouldUseLocalModels("local-codex", false)).toBe(true);
  });
});

describe("resolveTierSubtitle", () => {
  describe("local-claude-code: returns the versioned model label, never translated", () => {
    it("fast → Haiku 4.5", () => {
      expect(resolveTierSubtitle("local-claude-code", "fast", explodingT)).toBe(
        "Haiku 4.5",
      );
    });
    it("smart → Sonnet 5", () => {
      expect(
        resolveTierSubtitle("local-claude-code", "smart", explodingT),
      ).toBe("Sonnet 5");
    });
    it("thinking → Opus 5 1M", () => {
      expect(
        resolveTierSubtitle("local-claude-code", "thinking", explodingT),
      ).toBe("Opus 5 1M");
    });
  });

  describe("local-codex: returns the versioned model label, never translated", () => {
    it("fast → GPT-5.6 Luna", () => {
      expect(resolveTierSubtitle("local-codex", "fast", explodingT)).toBe(
        "GPT-5.6 Luna",
      );
    });
    it("smart → GPT-5.6 Terra", () => {
      expect(resolveTierSubtitle("local-codex", "smart", explodingT)).toBe(
        "GPT-5.6 Terra",
      );
    });
    it("thinking → GPT-5.6 Sol", () => {
      expect(resolveTierSubtitle("local-codex", "thinking", explodingT)).toBe(
        "GPT-5.6 Sol",
      );
    });
  });

  describe("cloud-decopilot: returns the translated intent description", () => {
    it("fast → the agentModels.quickerResponses translation", () => {
      expect(resolveTierSubtitle("cloud-decopilot", "fast", t)).toBe(
        en["chat.agentModels.quickerResponses"],
      );
    });
    it("smart → the agentModels.balancedQuality translation", () => {
      expect(resolveTierSubtitle("cloud-decopilot", "smart", t)).toBe(
        en["chat.agentModels.balancedQuality"],
      );
    });
    it("thinking → the agentModels.deeperReasoning translation", () => {
      expect(resolveTierSubtitle("cloud-decopilot", "thinking", t)).toBe(
        en["chat.agentModels.deeperReasoning"],
      );
    });
  });
});

import { describe, expect, it } from "bun:test";
import {
  agentModeFromOption,
  agentOptionFromMode,
  resolveTierSubtitle,
  type AgentMode,
} from "./use-agent-mode";
import type { AiProviderKey, AiProviderModel } from "@decocms/mesh-sdk";

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
  const emptyCtx = {
    slot: null,
    keys: [] as AiProviderKey[],
    slotModels: [] as AiProviderModel[],
    slotKeyId: null,
  };

  describe("local-claude-code", () => {
    it("returns Haiku label for fast tier", () => {
      expect(resolveTierSubtitle("local-claude-code", "fast", emptyCtx)).toBe(
        "Haiku",
      );
    });

    it("returns Sonnet label for smart tier", () => {
      expect(resolveTierSubtitle("local-claude-code", "smart", emptyCtx)).toBe(
        "Sonnet",
      );
    });

    it("returns Opus label for thinking tier", () => {
      expect(
        resolveTierSubtitle("local-claude-code", "thinking", emptyCtx),
      ).toBe("Opus");
    });
  });

  describe("local-codex", () => {
    it("returns GPT-5.4 Mini label for fast tier", () => {
      expect(resolveTierSubtitle("local-codex", "fast", emptyCtx)).toBe(
        "GPT-5.4 Mini",
      );
    });

    it("returns GPT-5.3 Codex label for smart tier", () => {
      expect(resolveTierSubtitle("local-codex", "smart", emptyCtx)).toBe(
        "GPT-5.3 Codex",
      );
    });

    it("returns GPT-5.5 label for thinking tier", () => {
      expect(resolveTierSubtitle("local-codex", "thinking", emptyCtx)).toBe(
        "GPT-5.5",
      );
    });
  });

  describe("cloud-decopilot", () => {
    it("returns slot.title when set", () => {
      const ctx = {
        slot: {
          keyId: "k1",
          modelId: "claude-sonnet-3.7",
          title: "Sonnet 3.7",
        },
        keys: [] as AiProviderKey[],
        slotModels: [] as AiProviderModel[],
        slotKeyId: "k1",
      };
      expect(resolveTierSubtitle("cloud-decopilot", "smart", ctx)).toBe(
        "Sonnet 3.7",
      );
    });

    it("falls back to slot.modelId when title is absent", () => {
      const ctx = {
        slot: { keyId: "k1", modelId: "claude-sonnet-3.7" },
        keys: [] as AiProviderKey[],
        slotModels: [] as AiProviderModel[],
        slotKeyId: "k1",
      };
      expect(resolveTierSubtitle("cloud-decopilot", "smart", ctx)).toBe(
        "claude-sonnet-3.7",
      );
    });

    it("returns null when slot is null and no keys are configured", () => {
      expect(resolveTierSubtitle("cloud-decopilot", "smart", emptyCtx)).toBe(
        null,
      );
    });

    it("returns null when slot is null and slotKeyId is null (current hook behaviour)", () => {
      const ctx = {
        slot: null,
        keys: [
          {
            id: "k1",
            providerId: "anthropic",
            label: "Anthropic",
            presetId: null,
            createdBy: "u1",
            createdAt: "2026-05-25",
          },
        ] as AiProviderKey[],
        slotModels: [] as AiProviderModel[],
        slotKeyId: null,
      };
      expect(resolveTierSubtitle("cloud-decopilot", "smart", ctx)).toBe(null);
    });
  });
});

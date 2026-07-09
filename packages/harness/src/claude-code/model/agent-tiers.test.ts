import { describe, expect, it } from "bun:test";
import { resolveAgentTier } from "./agent-tiers";

describe("resolveAgentTier", () => {
  it("resolves claude-code tiers", () => {
    expect(resolveAgentTier("claude-code", "fast")).toEqual({
      modelId: "claude-code:haiku",
      label: "Haiku 4.5",
    });
    expect(resolveAgentTier("claude-code", "smart")).toEqual({
      modelId: "claude-code:sonnet",
      label: "Sonnet 5",
    });
    expect(resolveAgentTier("claude-code", "thinking")).toEqual({
      modelId: "claude-code:opus-1m",
      label: "Opus 4.8 1M",
    });
  });

  it("resolves codex tiers", () => {
    expect(resolveAgentTier("codex", "fast")).toEqual({
      modelId: "codex:gpt-5.4-mini",
      label: "GPT-5.4 Mini",
    });
    expect(resolveAgentTier("codex", "smart")).toEqual({
      modelId: "codex:gpt-5.4",
      label: "GPT-5.4",
    });
  });

  it("returns null for decopilot — it uses the AI provider path instead", () => {
    expect(resolveAgentTier("decopilot", "fast")).toBeNull();
  });
});

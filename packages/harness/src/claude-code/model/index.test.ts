import { describe, expect, it } from "bun:test";
import { resolveAgentTier } from "./agent-tiers";
import type { ChatTier } from "./chat-tier";
import { resolveClaudeCodeModelId } from "./index";

describe("resolveClaudeCodeModelId", () => {
  it("resolves current Claude Code CLI model IDs to SDK aliases", () => {
    expect(resolveClaudeCodeModelId("claude-code:opus")).toBe("opus");
    expect(resolveClaudeCodeModelId("claude-code:sonnet")).toBe(
      "claude-sonnet-5",
    );
    expect(resolveClaudeCodeModelId("claude-code:haiku")).toBe("haiku");
    // Fable uses the full CLI model ID because the SDK doesn't have a short alias for it
    expect(resolveClaudeCodeModelId("claude-code:fable")).toBe(
      "claude-fable-5",
    );
  });

  it("passes through already-resolved aliases / full model IDs unchanged", () => {
    expect(resolveClaudeCodeModelId("sonnet")).toBe("sonnet");
    expect(resolveClaudeCodeModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(resolveClaudeCodeModelId("claude-fable-5")).toBe("claude-fable-5");
  });

  // Regression guard for the drift that broke the Thinking tier (PR #3760):
  // the tier map was switched to `claude-code:fable` without adding the
  // corresponding SDK mapping, so the composite ID leaked straight to the
  // CLI's `--model` flag. Every tier the harness can dispatch MUST resolve
  // to a non-composite SDK alias.
  it("maps every claude-code tier to a non-composite SDK alias", () => {
    const tiers: ChatTier[] = ["fast", "smart", "thinking"];
    for (const tier of tiers) {
      const entry = resolveAgentTier("claude-code", tier);
      expect(entry).not.toBeNull();
      const resolved = resolveClaudeCodeModelId(entry!.modelId);
      expect(resolved.startsWith("claude-code:")).toBe(false);
    }
  });

  it("uses Sonnet 5 for the Claude Code smart tier", () => {
    const entry = resolveAgentTier("claude-code", "smart");

    expect(entry).toEqual({
      modelId: "claude-code:sonnet",
      label: "Sonnet 5",
    });
    expect(resolveClaudeCodeModelId(entry!.modelId)).toBe("claude-sonnet-5");
  });

  it("maps Codex desktop tiers to the GPT-5.6 default trio", () => {
    expect(resolveAgentTier("codex", "thinking")).toEqual({
      modelId: "codex:gpt-5.6-sol",
      label: "GPT-5.6 Sol",
    });
    expect(resolveAgentTier("codex", "smart")).toEqual({
      modelId: "codex:gpt-5.6-terra",
      label: "GPT-5.6 Terra",
    });
    expect(resolveAgentTier("codex", "fast")).toEqual({
      modelId: "codex:gpt-5.6-luna",
      label: "GPT-5.6 Luna",
    });
  });
});

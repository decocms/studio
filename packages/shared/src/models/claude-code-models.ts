import type { ModelInfo } from "./types.ts";

/**
 * Browser-safe model list for the Claude Code desktop harness.
 */
export const CLAUDE_CODE_MODELS: ModelInfo[] = [
  {
    providerId: "claude-code",
    modelId: "claude-code:haiku",
    title: "Claude Code Haiku",
    description: "Fast and lightweight",
    capabilities: ["text"],
    limits: null,
    costs: null,
  },
  {
    providerId: "claude-code",
    modelId: "claude-code:sonnet",
    title: "Claude Code Sonnet 5",
    description: "Balanced performance",
    capabilities: ["text", "reasoning"],
    limits: null,
    costs: null,
  },
  {
    providerId: "claude-code",
    modelId: "claude-code:opus",
    title: "Claude Code Opus",
    description: "Most capable",
    capabilities: ["text", "reasoning"],
    limits: null,
    costs: null,
  },
  {
    providerId: "claude-code",
    modelId: "claude-code:opus-1m",
    title: "Claude Code Opus 4.8 1M",
    description: "Most capable, 1M context window",
    capabilities: ["text", "reasoning"],
    limits: { contextWindow: 1_000_000, maxOutputTokens: null },
    costs: null,
  },
];

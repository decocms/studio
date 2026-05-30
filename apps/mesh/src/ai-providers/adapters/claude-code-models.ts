import type { ModelInfo } from "../types";

/**
 * Browser-safe model list for the Claude Code desktop harness. Lives apart
 * from `claude-code.ts` because that file re-exports `createClaudeCodeModel`
 * from `../../harnesses/claude-code`, which transitively pulls
 * `ai-sdk-provider-claude-code` (and Node's `crypto`) into any bundle that
 * imports it. The chat model selector only needs the list — never the
 * harness factory — so it imports from here to keep `node:crypto` out of
 * the browser bundle.
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
    title: "Claude Code Sonnet",
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
];

import { createClaudeCode } from "ai-sdk-provider-claude-code";
import type { MeshProvider, ModelInfo, ProviderAdapter } from "../types";

export { createClaudeCodeModel } from "../coding-agents/claude-code";

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

/** Map composite model IDs (e.g. "claude-code:sonnet") to SDK model names. */
const CLAUDE_CODE_SDK_MODELS: Record<string, string> = {
  "claude-code:opus": "opus",
  "claude-code:sonnet": "sonnet",
  "claude-code:haiku": "haiku",
};

/** Resolve a composite claude-code model ID to the SDK model name. */
export function resolveClaudeCodeModelId(modelId: string): string {
  return CLAUDE_CODE_SDK_MODELS[modelId] ?? modelId;
}

export const claudeCodeAdapter: ProviderAdapter = {
  info: {
    id: "claude-code",
    name: "Claude Code",
    description: "Autonomous coding agent via Claude CLI",
    logo: "https://assets.decocache.com/decocms/2b91e6f8-5151-4b4f-bdf9-037ee769e6ff/Claude_AI_symbol.svg.png",
  },
  supportedMethods: ["cli-activate"],
  create(_apiKey): MeshProvider {
    // Claude Code doesn't use API keys, but we need to conform to the interface.
    // The real model creation happens via createClaudeCodeModel() with mcpServers.
    const provider = createClaudeCode({
      defaultSettings: {
        permissionMode: "bypassPermissions",
        disallowedTools: [
          "AskUserQuestion",
          "ExitPlanMode",
          "EnterWorktree",
          "ExitWorktree",
          "Config",
        ],
      },
    });
    return {
      info: claudeCodeAdapter.info,
      aiSdk: provider as any,
      async listModels(): Promise<ModelInfo[]> {
        return CLAUDE_CODE_MODELS;
      },
    };
  },
};

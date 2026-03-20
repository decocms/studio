import { createClaudeCode } from "ai-sdk-provider-claude-code";
import type { ToolApprovalLevel } from "../../api/routes/decopilot/helpers";
import type { MeshProvider, ModelInfo, ProviderAdapter } from "../types";

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

/**
 * Create a Claude Code language model with MCP servers attached.
 * This is separate from the adapter's create() because it needs
 * runtime config (mcpServers, permissionMode) that varies per request.
 */
export function createClaudeCodeModel(
  modelId: string,
  options?: {
    mcpServers?: Record<
      string,
      {
        type: "sse" | "http";
        url: string;
        headers?: Record<string, string>;
      }
    >;
    toolApprovalLevel?: ToolApprovalLevel;
  },
) {
  // Tools that require a TTY, manage local state, or are not useful in headless mode
  const HEADLESS_DISALLOWED_TOOLS = [
    "AskUserQuestion",
    "ExitPlanMode",
    "EnterWorktree",
    "ExitWorktree",
    "Config",
  ];

  const settings: NonNullable<
    NonNullable<Parameters<typeof createClaudeCode>[0]>["defaultSettings"]
  > = {
    mcpServers: options?.mcpServers,
  };

  switch (options?.toolApprovalLevel) {
    case "plan":
      settings.permissionMode = "plan";
      settings.disallowedTools = [...HEADLESS_DISALLOWED_TOOLS];
      break;
    case "readonly":
      settings.permissionMode = "bypassPermissions";
      settings.disallowedTools = [
        ...HEADLESS_DISALLOWED_TOOLS,
        "Write",
        "Edit",
        "Bash",
        "NotebookEdit",
      ];
      break;
    default:
      settings.permissionMode = "bypassPermissions";
      settings.disallowedTools = [...HEADLESS_DISALLOWED_TOOLS];
      break;
  }

  const provider = createClaudeCode({
    defaultSettings: settings,
  });
  return provider(modelId);
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

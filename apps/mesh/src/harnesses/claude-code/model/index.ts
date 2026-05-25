import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createClaudeCode } from "ai-sdk-provider-claude-code";
import type { ToolApprovalLevel } from "../../types";

/**
 * Create a Claude Code language model with MCP servers attached.
 * This is separate from the adapter's create() because it needs
 * runtime config (mcpServers, permissionMode, resume) that varies per request.
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
    /** Chat mode plan — same tool restrictions as readonly for headless CLI */
    isPlanMode?: boolean;
    resume?: string;
    /** Working directory for Claude Code's subprocess. Defaults to mesh's cwd. */
    cwd?: string;
    /** Extra tool names to disallow on top of the headless baseline. Used by
     *  task-specific agents (e.g. page-editor) that must not touch the
     *  filesystem or shell — agents under-follow textual prohibitions, so
     *  we hard-disable the tools at the SDK level. */
    extraDisallowedTools?: string[];
  },
): LanguageModelV3 {
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
    cwd: options?.cwd ?? process.cwd(),
  };

  const restrictWrites =
    options?.isPlanMode || options?.toolApprovalLevel === "readonly";

  const extra = options?.extraDisallowedTools ?? [];

  if (restrictWrites) {
    settings.permissionMode = "bypassPermissions";
    settings.disallowedTools = [
      ...HEADLESS_DISALLOWED_TOOLS,
      "Write",
      "Edit",
      "Bash",
      "NotebookEdit",
      ...extra,
    ];
  } else {
    settings.permissionMode = "bypassPermissions";
    settings.disallowedTools = [...HEADLESS_DISALLOWED_TOOLS, ...extra];
  }

  if (options?.resume) {
    settings.resume = options.resume;
  }

  const provider = createClaudeCode({
    defaultSettings: settings,
  });
  return provider(modelId);
}

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

import { createClaudeCode } from "ai-sdk-provider-claude-code";
import type { ToolApprovalLevel } from "@/api/routes/decopilot/helpers";

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
    resume?: string;
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
    cwd: process.cwd(),
  };

  switch (options?.toolApprovalLevel) {
    case "plan":
      settings.permissionMode = "bypassPermissions";
      settings.disallowedTools = [
        ...HEADLESS_DISALLOWED_TOOLS,
        "Write",
        "Edit",
        "Bash",
        "NotebookEdit",
      ];
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

  if (options?.resume) {
    settings.resume = options.resume;
  }

  const provider = createClaudeCode({
    defaultSettings: settings,
  });
  return provider(modelId);
}

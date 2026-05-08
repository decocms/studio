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
    /** Chat mode plan — same tool restrictions as readonly for headless CLI */
    isPlanMode?: boolean;
    resume?: string;
    /** Working directory for Claude Code's subprocess. Defaults to mesh's cwd. */
    cwd?: string;
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
    cwd: options?.cwd ?? process.cwd(),
  };

  const restrictWrites =
    options?.isPlanMode || options?.toolApprovalLevel === "readonly";

  if (restrictWrites) {
    settings.permissionMode = "bypassPermissions";
    settings.disallowedTools = [
      ...HEADLESS_DISALLOWED_TOOLS,
      "Write",
      "Edit",
      "Bash",
      "NotebookEdit",
    ];
  } else {
    settings.permissionMode = "bypassPermissions";
    settings.disallowedTools = [...HEADLESS_DISALLOWED_TOOLS];
  }

  if (options?.resume) {
    settings.resume = options.resume;
  }

  const provider = createClaudeCode({
    defaultSettings: settings,
  });
  return provider(modelId);
}

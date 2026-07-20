import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createClaudeCode } from "ai-sdk-provider-claude-code";
import { resolveClaudeCodeExecutable } from "../resolve-executable";
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
    systemPrompt?:
      | string
      | {
          type: "preset";
          preset: "claude_code";
          append?: string;
        };
    /** Working directory for Claude Code's subprocess. Defaults to studio's cwd. */
    cwd?: string;
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
    // ai-sdk-provider-claude-code@3.5.0 changed: when settingSources is
    // undefined, it now passes [] to the binary (no settings loaded at all).
    // In 3.4.4 it was omitted, letting the binary use its defaults (user
    // plugins/skills). Restore that by explicitly requesting all three sources
    // so user skills (e.g. superpower), project .claude/ config, and
    // machine-local overrides all load in headless mode.
    settingSources: ["user", "project", "local"],
  };

  // Pin the native binary that matches this host's libc. Without this the SDK
  // self-resolves it, and on some glibc hosts its detection wrongly picks the
  // `-musl` binary (which can't launch) — see resolveClaudeCodeExecutable. When
  // it returns undefined (non-linux, or it can't resolve) we omit the option
  // and let the SDK resolve as before.
  const executablePath = resolveClaudeCodeExecutable();
  if (executablePath) {
    settings.pathToClaudeCodeExecutable = executablePath;
  }

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

  if (options?.systemPrompt) {
    settings.systemPrompt = options.systemPrompt;
  }

  const provider = createClaudeCode({
    defaultSettings: settings,
  });
  return provider(modelId);
}

/** Map composite model IDs (e.g. "claude-code:sonnet") to SDK model names.
 *
 * NOTE: The ai-sdk-provider-claude-code SDK only recognises the short aliases
 * "opus", "sonnet", and "haiku". Any other string is passed straight through to
 * the CLI's --model flag. For models not covered by a short alias (Fable 5,
 * Sonnet 5, Opus 4.8 1M) we therefore use the full CLI model ID so the CLI can
 * resolve it correctly. For example, Sonnet 5 uses `claude-sonnet-5`, while
 * Opus 4.8 with 1M context uses `opus[1m]`.
 */
const CLAUDE_CODE_SDK_MODELS: Record<string, string> = {
  "claude-code:opus": "opus",
  "claude-code:opus-1m": "opus[1m]",
  "claude-code:sonnet": "claude-sonnet-5",
  "claude-code:haiku": "haiku",
  "claude-code:fable": "claude-fable-5",
};

/** Resolve a composite claude-code model ID to the SDK model name. */
export function resolveClaudeCodeModelId(modelId: string): string {
  return CLAUDE_CODE_SDK_MODELS[modelId] ?? modelId;
}

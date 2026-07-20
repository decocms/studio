import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
  createCodexAppServer,
  type CodexAppServerProvider,
} from "ai-sdk-provider-codex-cli";
import type { ToolApprovalLevel } from "../../types";

/**
 * Create a Codex language model with MCP servers attached.
 * This mirrors createClaudeCodeModel() — it needs runtime config
 * (mcpServers, approvalPolicy) that varies per request.
 *
 * IMPORTANT: The caller MUST call provider.close() when done to
 * terminate the persistent codex app-server process.
 */
export function createCodexModel(
  modelId: string,
  options?: {
    mcpServers?: Record<
      string,
      {
        transport: "http";
        url: string;
        headers?: Record<string, string>;
      }
    >;
    toolApprovalLevel?: ToolApprovalLevel;
    /** Chat mode plan — stricter approval policy */
    isPlanMode?: boolean;
    /** Working directory for Codex's app-server subprocess. Defaults to
     *  studio's cwd — mirrors `createClaudeCodeModel`. Without this, the
     *  codex CLI runs in the daemon's own cwd (typically the app root)
     *  instead of the cloned repo, so file edits land in the wrong tree. */
    cwd?: string;
    developerInstructions?: string;
    /** On-disk thread id to resume. Omit on the first turn. */
    resume?: string;
  },
): { model: LanguageModelV3; provider: CodexAppServerProvider } {
  const defaultSettings = buildCodexDefaultSettings(options);

  const provider = createCodexAppServer({
    defaultSettings,
  });

  return { model: provider(modelId), provider };
}

type CodexModelOptions = NonNullable<Parameters<typeof createCodexModel>[1]>;

export function buildCodexDefaultSettings(options?: CodexModelOptions) {
  const mcpServers = options?.mcpServers
    ? Object.fromEntries(
        Object.entries(options.mcpServers).map(([name, config]) => [
          name,
          {
            transport: config.transport as "http",
            url: config.url,
            httpHeaders: config.headers,
          },
        ]),
      )
    : undefined;

  let approvalPolicy: "never" | "on-failure";
  if (options?.isPlanMode || options?.toolApprovalLevel === "readonly") {
    approvalPolicy = "on-failure";
  } else {
    approvalPolicy = "never";
  }

  return {
    mcpServers,
    approvalPolicy,
    cwd: options?.cwd ?? process.cwd(),
    rmcpClient: true,
    sandboxPolicy: "danger-full-access",
    // Persistent so the FIRST turn creates a non-ephemeral, resumable
    // on-disk thread (stateless mode would create an ephemeral one).
    threadMode: "persistent",
    ...(options?.resume ? { resume: options.resume } : {}),
    connectionTimeoutMs: 30_000,
    requestTimeoutMs: 300_000,
    idleTimeoutMs: 60_000,
    ...(options?.developerInstructions
      ? { developerInstructions: options.developerInstructions }
      : {}),
  } satisfies NonNullable<
    Parameters<typeof createCodexAppServer>[0]
  >["defaultSettings"];
}

/** Map composite model IDs to SDK model names. */
const CODEX_SDK_MODELS: Record<string, string> = {
  "codex:gpt-5.6-sol": "gpt-5.6-sol",
  "codex:gpt-5.6-terra": "gpt-5.6-terra",
  "codex:gpt-5.6-luna": "gpt-5.6-luna",
  "codex:gpt-5.5": "gpt-5.5",
  "codex:gpt-5.4": "gpt-5.4",
  "codex:gpt-5.4-mini": "gpt-5.4-mini",
  "codex:gpt-5.3-codex-spark": "gpt-5.3-codex-spark",
};

/** Resolve a composite codex model ID to the SDK model name. */
export function resolveCodexModelId(modelId: string): string {
  const resolved = CODEX_SDK_MODELS[modelId];
  if (!resolved) {
    throw new Error(`Unknown Codex model ID: ${modelId}`);
  }
  return resolved;
}

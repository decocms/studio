/**
 * The `claude-code` harness: one Studio dispatch → one Claude Agent SDK turn.
 *
 * Runs inside the sandbox pod, next to the checkout the daemon already cloned.
 * Studio hands over a `HarnessStreamInputWire`; this returns the turn's whole
 * `UIMessageChunk[]`, which is all a turn ever is here — the SDK reports
 * nothing Studio can render until `result`. That is also what makes the
 * assistant `messageId` derivable (the Anthropic message id of the turn, so a
 * re-delivered turn dedupes).
 *
 * Tools come from two places and neither needs configuring here: Claude Code's
 * built-ins operate on the checkout, and Studio's org tools arrive over MCP
 * from the endpoint minted for this run. Permissions are bypassed — the pod is
 * the isolation boundary, and there is no UI to answer a prompt.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";
import {
  turnFinishChunks,
  turnStartChunks,
  UiChunkTranslator,
  type SdkResultMessage,
} from "./to-ui-chunks";

const ENVS = {
  STUDIO_MCP_SERVER_NAME: "studio",
  MODEL_ENV: "CLAUDE_CODE_MODEL",
  EXECUTABLE_ENV: "CLAUDE_CODE_PATH",
};

/** One turn's output. `error` accompanies whatever the turn managed to produce. */
export interface HarnessRunResult {
  chunks: unknown[];
  error?: { code: string; message: string } | null;
}

/** Extract the prompt text from Studio's opaque `userMessage` wire object. */
export function promptFromUserMessage(userMessage: unknown): string {
  if (typeof userMessage !== "object" || userMessage === null) return "";
  const parts = (userMessage as { parts?: unknown }).parts;
  if (Array.isArray(parts)) {
    const texts: string[] = [];
    for (const part of parts) {
      if (typeof part !== "object" || part === null) continue;
      const typed = part as { type?: unknown; text?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") {
        texts.push(typed.text);
      }
    }
    if (texts.length > 0) return texts.join("\n");
  }
  const content = (userMessage as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

/**
 * Where this thread's Claude Code session id is remembered.
 *
 * Stored, not derived: one file under the same config dir as the transcript the
 * SDK keeps, so the id and the session it names live and die together. Resuming
 * an id the SDK never persisted fails the whole run, so "no file" has to mean
 * "no session", and it does.
 */
function sessionFile(threadId: string): string {
  const dir =
    process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME ?? "."}/.claude`;
  return `${dir}/deco-sessions/${threadId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** SDK options for one run. Exported for the unit test — it is the whole policy. */
export function buildOptions(args: {
  input: HarnessStreamInputWire;
  sessionId: string;
  resume: boolean;
}): Options {
  const { input, sessionId, resume } = args;
  const cwd = input.workspace.cwd ?? undefined;
  const instructions = input.agent.instructions;
  const model = process.env[ENVS.MODEL_ENV];
  const executable = process.env[ENVS.EXECUTABLE_ENV];
  return {
    ...(cwd ? { cwd } : {}),
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    // The pod is the isolation boundary and no approval UI exists upstream.
    permissionMode: "bypassPermissions",
    // Keep Claude Code's own prompt (it is what makes the built-in tools work)
    // and append the Studio agent's instructions rather than replacing it.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(instructions ? { append: instructions } : {}),
    },
    ...(model ? { model } : {}),
    // Resume keeps the thread's history in the SDK's own transcript instead of
    // replaying it as prompt text. `sessionId` seeds a new one at the same id
    // so the next turn can resume it.
    ...(resume ? { resume: sessionId } : { sessionId }),
    ...(input.mcp.url
      ? {
          mcpServers: {
            [ENVS.STUDIO_MCP_SERVER_NAME]: {
              type: "http" as const,
              url: input.mcp.url,
              headers: input.mcp.headers,
            },
          },
        }
      : {}),
  };
}

/**
 * Run one turn and return its chunks. An SDK throw becomes `error` alongside
 * whatever the turn had already produced, so a crash mid-turn still shows the
 * work instead of an empty message.
 */
export async function runClaudeCode(
  input: HarnessStreamInputWire,
): Promise<HarnessRunResult> {
  const file = sessionFile(input.threadId);
  const stored = (
    await Bun.file(file)
      .text()
      .catch(() => "")
  ).trim();
  const sessionId = stored || crypto.randomUUID();

  const translator = new UiChunkTranslator();
  const buffered: unknown[] = [];
  let messageId: string | undefined;

  try {
    const stream = query({
      prompt: promptFromUserMessage(input.userMessage),
      options: buildOptions({ input, sessionId, resume: stored.length > 0 }),
    });

    const startedAt = Date.now();
    for await (const message of stream) {
      // Every SDK message, with the seconds it took to arrive. Without this a
      // run stalled on the model, on a tool, or on MCP looks exactly like a run
      // that is working — both are silence in the pod log.
      console.error(
        `[claude-code] sdk ${message.type}${
          "subtype" in message && message.subtype ? `/${message.subtype}` : ""
        } +${Math.round((Date.now() - startedAt) / 1000)}s`,
      );
      // A failed MCP connection is not an error the SDK raises — the tools just
      // aren't in the model's list, and the run reads as "the agent ignored its
      // instructions". The init message is the only place that distinguishes
      // the two, so log it.
      if (message.type === "system" && message.subtype === "init") {
        console.error(
          `[claude-code] mcp: ${
            message.mcp_servers
              .map((server) => `${server.name}=${server.status}`)
              .join(" ") || "none configured"
          } | studio tools: ${
            message.tools.filter((tool) => tool.startsWith("mcp__")).length
          }`,
        );
      }
      // First Anthropic message id of the turn becomes Studio's assistant
      // message id: stable if the same turn is delivered twice.
      if (!messageId && message.type === "assistant") {
        const id = message.message.id;
        if (typeof id === "string" && id.length > 0) messageId = id;
      }
      for (const chunk of translator.translate(message)) buffered.push(chunk);
      if (message.type !== "result") continue;
      // Remember the session only once a turn completed on it. ponytail: a
      // failed turn therefore starts the next one fresh, losing the history —
      // the alternative is resuming a session the SDK may have left unwritten,
      // which fails the whole run instead of just forgetting.
      await Bun.write(file, sessionId);
      const id = messageId ?? `msg_${message.uuid}`;
      return {
        chunks: [
          ...turnStartChunks(id),
          ...buffered,
          ...turnFinishChunks(message as SdkResultMessage),
        ],
      };
    }
    return failed(buffered, messageId, "claude-code ended without a result");
  } catch (err) {
    return failed(
      buffered,
      messageId,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Whatever the failed turn produced, plus the error that ended it. */
function failed(
  buffered: unknown[],
  messageId: string | undefined,
  message: string,
): HarnessRunResult {
  return {
    chunks:
      buffered.length > 0
        ? [
            ...turnStartChunks(messageId ?? `msg_${Date.now()}`),
            ...buffered,
            { type: "finish-step" },
            { type: "finish", finishReason: "error" },
          ]
        : [],
    error: { code: "harness_crashed", message },
  };
}

/**
 * The `claude-code` harness: one Studio dispatch → one Claude Agent SDK turn.
 *
 * Runs inside the sandbox pod, next to the checkout the daemon already cloned.
 * Studio hands over a `HarnessStreamInputWire`; this returns the same
 * `DispatchSSEEvent` stream any harness returns, so the daemon and every
 * consumer upstream of it are unchanged.
 *
 * v1 is deliberately turn-buffered, not incremental: chunks accumulate and
 * flush when the SDK reports `result`. That is what makes the assistant
 * `messageId` derivable (it is the Anthropic message id of the turn, so a
 * re-delivered turn dedupes) and it keeps the wire quiet during long tool
 * runs. Studio's own `withLivenessHeartbeat` covers the silence.
 *
 * Tools come from two places and neither needs configuring here: Claude Code's
 * built-ins operate on the checkout, and Studio's org tools arrive over MCP
 * from the endpoint minted for this run. Permissions are bypassed — the pod is
 * the isolation boundary, and there is no UI to answer a prompt.
 */

import { getSessionInfo, query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";
import type { DispatchSSEEvent } from "@decocms/sandbox/dispatch/schemas";
import { sessionIdForThread } from "./session-id";
import {
  turnFinishChunks,
  turnStartChunks,
  UiChunkTranslator,
  type SdkResultMessage,
} from "./to-ui-chunks";

/**
 * Name the Studio MCP server is mounted under. Tools reach the model as
 * `mcp__studio__<TOOL_NAME>`; changing this renames every tool the model has
 * learned, so treat it as wire.
 */
const STUDIO_MCP_SERVER_NAME = "studio";

/**
 * Model override. Unset means Claude Code's own default, which is the honest
 * v1 behavior: Studio's model picker selects credential-scoped ids that do not
 * map onto the slugs this SDK's endpoint expects. An env var lets ops pin a
 * model without a code change.
 */
const MODEL_ENV = "CLAUDE_CODE_MODEL";

/**
 * Explicit path to the `claude` binary. The image sets it (the CLI is installed
 * globally, in a different node_modules tree than the SDK), so the SDK never
 * has to guess where its executable lives.
 */
const EXECUTABLE_ENV = "CLAUDE_CODE_PATH";

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

/** SDK options for one run. Exported for the unit test — it is the whole policy. */
export function buildOptions(args: {
  input: HarnessStreamInputWire;
  sessionId: string;
  resume: boolean;
  abortController: AbortController;
}): Options {
  const { input, sessionId, resume } = args;
  const cwd = input.workspace.cwd ?? undefined;
  const instructions = input.agent.instructions;
  const model = process.env[MODEL_ENV];
  const executable = process.env[EXECUTABLE_ENV];
  return {
    abortController: args.abortController,
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
            [STUDIO_MCP_SERVER_NAME]: {
              type: "http" as const,
              url: input.mcp.url,
              headers: input.mcp.headers,
            },
          },
        }
      : {}),
  };
}

function uiEvent(chunk: unknown): DispatchSSEEvent {
  return { type: "ui-message-chunk", chunk };
}

/**
 * Run one turn. Yields `ui-message-chunk` events followed by nothing — the
 * caller writes the terminal `done`. An SDK throw becomes an `error` event
 * AFTER whatever the turn had already produced, so a crash mid-turn still
 * shows the work instead of an empty message.
 */
export async function* runClaudeCode(
  input: HarnessStreamInputWire,
  signal: AbortSignal,
): AsyncGenerator<DispatchSSEEvent> {
  const sessionId = sessionIdForThread(input.threadId);
  const cwd = input.workspace.cwd ?? undefined;
  // Resuming a session that was never persisted (fresh pod, org-fs mount
  // empty) makes the SDK fail the run, so ask before assuming.
  const existing = await getSessionInfo(
    sessionId,
    cwd ? { dir: cwd } : {},
  ).catch(() => undefined);

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (signal.aborted) abortController.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  const translator = new UiChunkTranslator();
  const buffered: unknown[] = [];
  let messageId: string | undefined;

  try {
    const stream = query({
      prompt: promptFromUserMessage(input.userMessage),
      options: buildOptions({
        input,
        sessionId,
        resume: existing !== undefined,
        abortController,
      }),
    });

    for await (const message of stream) {
      // First Anthropic message id of the turn becomes Studio's assistant
      // message id: stable if the same turn is delivered twice.
      if (!messageId && message.type === "assistant") {
        const id = message.message.id;
        if (typeof id === "string" && id.length > 0) messageId = id;
      }
      for (const chunk of translator.translate(message)) buffered.push(chunk);
      if (message.type !== "result") continue;
      const id = messageId ?? `msg_${message.uuid}`;
      for (const chunk of turnStartChunks(id)) yield uiEvent(chunk);
      for (const chunk of buffered) yield uiEvent(chunk);
      for (const chunk of turnFinishChunks(message as SdkResultMessage)) {
        yield uiEvent(chunk);
      }
      return;
    }

    // The stream ended without a `result`. Cancellation is the client's doing
    // and needs no error; anything else is a harness failure.
    if (signal.aborted) return;
    yield* flushPartial(
      buffered,
      messageId,
      "claude-code ended without a result",
    );
  } catch (err) {
    if (signal.aborted) return;
    const detail = err instanceof Error ? err.message : String(err);
    yield* flushPartial(buffered, messageId, detail);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Emit whatever the failed turn produced, then the error. */
function* flushPartial(
  buffered: unknown[],
  messageId: string | undefined,
  errorText: string,
): Generator<DispatchSSEEvent> {
  if (buffered.length > 0) {
    for (const chunk of turnStartChunks(messageId ?? `msg_${Date.now()}`)) {
      yield uiEvent(chunk);
    }
    for (const chunk of buffered) yield uiEvent(chunk);
    yield uiEvent({ type: "finish-step" });
    yield uiEvent({ type: "finish", finishReason: "error" });
  }
  yield { type: "error", code: "harness_crashed", message: errorText };
}

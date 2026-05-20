/**
 * runDecopilotStream
 *
 * The decopilot harness's streamText loop, extracted from
 * `stream-core.ts` (~lines 780–1582) into a standalone async generator.
 * Owns:
 *  - Background title generation (kicked off in parallel with the main
 *    LLM stream, gated on `currentThreadTitle === DEFAULT_THREAD_TITLE`).
 *  - `streamText` invocation with the full set of callbacks: `prepareStep`
 *    (todo-write strip + inject, image injection, plan-mode tool gating,
 *    forced-first-step toolChoice), `onFinish`/`onError`/`onAbort`
 *    (LLM-call metrics + monitoring, otel span lifecycle).
 *  - `result.toUIMessageStream({ messageMetadata })` chunk producer that
 *    decorates chunks with start/step/finish metadata (model id, usage,
 *    cache token details, coding-agent session ids).
 *  - Auto-title chunk emission (`data-thread-title`) — yielded through
 *    the same async iterator as the main stream chunks.
 *  - Abort-time `message-metadata` re-emission so the UI keeps the
 *    accumulated usage that the SDK would otherwise reset to its
 *    pre-stream state.
 *
 * The helper is intentionally CLI-agent-free — the claude-code / codex
 * branches that live inline in `stream-core.ts` belong to their own
 * harnesses (see Tasks 9 + 10). Everything here assumes a regular,
 * activated `MeshProvider` and the full tool set assembled by
 * `assembleDecopilotTools`.
 *
 * Today this code lives inline inside `stream-core.ts`; the helper here
 * is unused until Task 12 wires it through the harness factory. Behavior
 * is intended to be byte-for-byte the same as the inline version.
 *
 * Important difference from the inline original: the original calls
 * `writer.write(chunk)` from `onAbort` and from the auto-title `then`
 * callback to push side-channel chunks into the merged UI message
 * stream. The async-generator shape doesn't have a writer to call back
 * into, so this module hosts a tiny internal queue: callbacks push
 * chunks onto it, and the main yield loop drains it alongside the
 * `toUIMessageStream` output. The queue closes when the streamText
 * stream ends, so any callback firing after that point (today: only
 * `genTitle.promise.then` if the title resolves post-stream) is a no-op
 * for the SSE channel — mirroring the inline original's `streamFinished`
 * guard.
 */

import type { MeshContext } from "@/core/mesh-context";
import { monitorLlmCall } from "@/monitoring/emit-llm-call";
import { recordLlmCallMetrics } from "@/monitoring/record-llm-call-metrics";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
  type UIMessageChunk,
  stepCountIs,
  streamText,
} from "ai";
import { tracer } from "@/observability";
import type { MeshProvider } from "@/ai-providers/types";

import { createEnableToolTool } from "./built-in-tools/enable-tool";
import type { PendingImage } from "./built-in-tools";
import { OPENROUTER_CACHE_PROVIDER_OPTIONS } from "../../api/routes/decopilot/cache-instrumentation";
import { createUsageAccumulator } from "../usage-accumulator";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_THREAD_TITLE,
  generateMessageId,
  PARENT_STEP_LIMIT,
} from "../../api/routes/decopilot/constants";
import { resolveModeConfig } from "../../api/routes/decopilot/mode-config";
import { genTitle } from "./title-generator";
import type { ChatMessage } from "../../api/routes/decopilot/types";
import type { RunRegistry } from "../../api/routes/decopilot/run-registry";
import { createLanguageModel } from "../../ai-providers/language-model";
import type { HarnessStreamInput } from "../types";
import type { AssembledTools } from "./tools";
import type { AssembledPrompt } from "./prompt";
import { sanitizeStreamError, stringifyError } from "./stream-error";

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Reconstruct the set of enabled tools from conversation history.
 * Scans for prior `enable_tools` calls and re-adds their tool names.
 */
function reconstructEnabledTools(
  messages: ChatMessage[],
  availableToolNames: Set<string>,
): Set<string> {
  const enabled = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.parts) {
      if (
        "toolName" in part &&
        (part.toolName === "enable_tool" || part.toolName === "enable_tools") &&
        "result" in part &&
        part.result
      ) {
        const result = part.result as { enabled?: string[] };
        if (Array.isArray(result.enabled)) {
          for (const name of result.enabled) {
            // Normalize stored names: old threads may have hyphenated names
            // (e.g. conn-togsm0..._tool) while current safe names use underscores.
            const normalized = name.replace(/[^a-zA-Z0-9_]/g, "_");
            if (availableToolNames.has(normalized)) {
              enabled.add(normalized);
            } else if (availableToolNames.has(name)) {
              enabled.add(name);
            }
          }
        }
      }
    }
  }
  return enabled;
}

// ─────────────────────────────────────────────────────────────────────
// Extras shape
// ─────────────────────────────────────────────────────────────────────

/**
 * Per-request extras that don't live in `HarnessStreamInput` and aren't
 * produced by `assembleDecopilotTools` / `assembleDecopilotPrompt`. These
 * are the bits that have to be plumbed in from the surrounding
 * stream-core scope (caller — today inline, in Task 12 the harness
 * factory wiring).
 *
 * Everything here is read by the streamText loop or by one of its
 * inline callbacks (`prepareStep`, `onFinish`, `onError`, `onAbort`, or
 * the `toUIMessageStream({ messageMetadata })` decorator). Adding fields
 * outside of that set is over-spec — keep the extras minimal so the
 * boundary is auditable.
 */
export interface RunDecopilotStreamExtras {
  /**
   * Already-activated MeshProvider — the caller has resolved the
   * credential id to a key/headers and called `ctx.aiProviders.activate`
   * before invoking us. `null` is rejected (decopilot, unlike CLI
   * harnesses, always has a provider).
   *
   * Source in the inline original: the `provider` local declared at
   * line ~288 via `Promise.all([... ctx.aiProviders.activate(...) ...])`.
   */
  provider: MeshProvider;

  /**
   * Run-registry abort signal for this run. Listened to by streamText
   * (`abortSignal`), by genTitle (`abortSignal`), and queried from
   * `onFinish`/`onAbort` callbacks to distinguish a real model finish
   * from a user-cancel.
   *
   * Source: `runRegistry.getAbortSignal(mem.thread.id)` — the registry
   * owns the AbortController so the cancellation signal propagates to
   * everyone listening (close-clients, MCP passthrough, title gen, etc.).
   */
  registrySignal: AbortSignal;

  /**
   * The run-registry itself. Today this is unused inside `runDecopilotStream`
   * but is forwarded from the outer dispatch in case future deferred-finish
   * recovery paths need it. Kept to preserve a single shape for
   * `HarnessProcessLocal` across in-tree consumers.
   *
   * Source: passed in through `dispatchRun`'s `deps.runRegistry`.
   */
  runRegistry: RunRegistry;

  /**
   * The Anthropic-cached system messages produced by
   * `assembleDecopilotPrompt` — passed in via `prompt.systemMessages`
   * already, BUT the streamText call also concatenates per-request
   * system messages produced by `processConversation` (the user's
   * inline <system> messages). Those don't go through prompt assembly,
   * so the caller has to forward them.
   *
   * Source in the inline original: `processedSystemMessages` returned
   * from `processConversation(materializedMessages, …)`.
   */
  processedSystemMessages: SystemModelMessage[];

  /**
   * The pruned ModelMessage stream that streamText consumes as the
   * conversation. Same source: `processedMessages` returned from
   * `processConversation`.
   */
  processedMessages: Extract<
    ModelMessage,
    { role: "user" | "assistant" | "tool" }
  >[];

  /**
   * The validated UIMessage[] that `result.toUIMessageStream` uses as
   * `originalMessages` (so the SDK can dedupe ids when re-streaming).
   *
   * Source: `originalMessages` returned from `processConversation`.
   */
  originalMessages: ChatMessage[];

  /**
   * Thread id — used in spans, posthog events, and registry FINISH
   * dispatch. Today this equals `mem.thread.id` (the source of truth).
   * Identical to `input.threadId` in well-formed callers, but we plumb
   * it through extras so the helper doesn't have to assert that
   * equivalence.
   */
  threadId: string;

  /**
   * Initial value of `mem.thread.title` at request entry. Title
   * generation only kicks off when this equals `DEFAULT_THREAD_TITLE`
   * ("New chat") — the convention for an unrenamed thread.
   *
   * NOTE: this duplicates `input.currentThreadTitle`. Kept as a separate
   * extra because the surrounding stream-core code today loads the title
   * from the `Memory` object, not from input. When Task 12 wires this
   * together, the two will collapse to one — for now we just forward
   * `input.currentThreadTitle ?? mem.thread.title`.
   */
  currentThreadTitle: string;

  /**
   * Push callback for title-generation work. The streamText loop
   * registers `titleHandle.promise.then(...)` as a pending op so the
   * outer createUIMessageStream's `onFinish` can `await
   * Promise.allSettled(pendingOps)` before tearing down the writer.
   * Without this hook the title generation would race with stream
   * teardown.
   *
   * Source in the inline original: `pendingOps.push(titleOp)` at line
   * ~829, where `pendingOps` is a local in the outer scope.
   */
  registerPendingOp: (op: Promise<void>) => void;

  /**
   * Fired when the outer onFinish runs — used to gate the auto-title
   * chunk emission against late title resolutions that arrive after
   * the SSE channel has already been closed. Mirrors the inline
   * `if (!streamFinished)` check at line ~805.
   *
   * Source in the inline original: a `streamFinished` boolean local
   * declared at line 471, flipped to true in `createUIMessageStream`'s
   * `onFinish`/`onError` callbacks (lines 1588, 1675).
   */
  isStreamFinished: () => boolean;

  /**
   * Called once per `streamText.onFinish` to report the cumulative
   * totalUsage of the LLM call. The outer scope uses this to populate
   * `posthog`'s `chat_message_completed` event with input/output/total
   * token counts. Called with `{0,0,0}` when totalUsage is undefined —
   * mirroring the inline original where `aggregatedUsage` only grew on
   * successful finish events.
   *
   * Source in the inline original: the `aggregatedUsage` local at
   * line 519, mutated in streamText.onFinish (line ~1160) and read by
   * the outer createUIMessageStream.onFinish posthog emit (line 1644).
   */
  onUsageAggregated: (totalUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }) => void;

  /**
   * Screenshot images captured by `take_screenshot` during tool execution.
   * The list is mutated in place by the built-in tool (it pushes when a
   * screenshot succeeds) and by `prepareStep` (it splices the list out
   * to embed in the next user message). MUST be the same array reference
   * passed to `assembleDecopilotTools` — otherwise the screenshot tool
   * writes to one array and `prepareStep` reads from another, and the
   * images never reach the model.
   *
   * Source in the inline original: a `pendingImages: PendingImage[]`
   * declared at line 516 in stream-core, shared between the inline
   * built-in tools setup and the inline `prepareStep`.
   */
  pendingImages: PendingImage[];

  /**
   * Called after the auto-titler commits a new title to the DB.
   * Implementations emit a `decopilot.thread.status` SSE event so tabs
   * that are NOT subscribed to this thread's `/stream` see the new title.
   * Optional — callers that cannot supply sseHub (e.g. test harnesses,
   * orphan-recovery without a buffer) may omit it; the omission is safe.
   *
   * Source: wired by `dispatch-run.ts`'s `prepareRun` when `deps.sseHub`
   * is available.
   */
  onTitleUpdated?: (title: string) => void | Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────
// Async-queue plumbing
// ─────────────────────────────────────────────────────────────────────

/**
 * Tiny single-producer, single-consumer chunk queue used to merge
 * side-channel chunks (today: abort-time `message-metadata` and the
 * auto-title `data-thread-title`) into the main `for await` iteration
 * over `result.toUIMessageStream()`. Closing the queue ends any
 * in-flight wait so the generator can return promptly.
 */
function makeChunkQueue(): {
  push: (chunk: UIMessageChunk) => void;
  next: () => Promise<{ done: false; value: UIMessageChunk } | { done: true }>;
  close: () => void;
} {
  const buffer: UIMessageChunk[] = [];
  let closed = false;
  let waiter:
    | ((v: { done: false; value: UIMessageChunk } | { done: true }) => void)
    | null = null;

  return {
    push(chunk) {
      if (closed) return;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ done: false, value: chunk });
      } else {
        buffer.push(chunk);
      }
    },
    next() {
      if (buffer.length > 0) {
        const value = buffer.shift()!;
        return Promise.resolve({ done: false as const, value });
      }
      if (closed) return Promise.resolve({ done: true as const });
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    close() {
      closed = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ done: true });
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────

/**
 * Run the decopilot streamText loop and yield its UIMessageChunk
 * stream. The generator owns the LLM-call lifetime; on completion (or
 * abort) it tears down the otel span and resolves any background title
 * work registered through `extras.registerPendingOp`.
 *
 * Side-channel chunks (auto-title chunk + abort-time message-metadata
 * chunk) are pushed onto an internal queue and interleaved into the
 * main yield loop, matching the inline `writer.write` semantics
 * byte-for-byte.
 */
export async function* runDecopilotStream(
  input: HarnessStreamInput,
  ctx: MeshContext,
  tools: AssembledTools,
  prompt: AssembledPrompt,
  extras: RunDecopilotStreamExtras,
): AsyncGenerator<UIMessageChunk> {
  const {
    provider,
    registrySignal,
    processedSystemMessages,
    processedMessages,
    originalMessages,
    threadId,
    currentThreadTitle,
    registerPendingOp,
    isStreamFinished,
    onTitleUpdated,
  } = extras;

  const modeConfig = resolveModeConfig(input.mode, { isCliAgent: false });
  const maxOutputTokens =
    input.models.thinking.limits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  let llmCallStartTime: number | undefined;
  let llmCallLogged = false;

  // Side-channel chunk queue — see `makeChunkQueue` jsdoc for why.
  const chunkQueue = makeChunkQueue();

  // ── Auto-title: kick off in parallel with the main stream ─────────
  //
  // Title generation only runs when the thread is still using the
  // default name AND we have a non-CLI provider (we always do here —
  // the CLI branches live in their own harness). When the title
  // promise resolves, persist the new value and push the
  // `data-thread-title` chunk onto the queue — so it interleaves with
  // the main streamText output via the generator's yield loop.
  let titleHandle: ReturnType<typeof genTitle> | null = null;
  const shouldGenerateTitle = currentThreadTitle === DEFAULT_THREAD_TITLE;
  if (shouldGenerateTitle) {
    const titleInput = JSON.stringify(processedMessages[0]?.content);
    titleHandle = genTitle({
      abortSignal: registrySignal,
      model: createLanguageModel(
        provider,
        input.models.fast ?? input.models.thinking,
      ),
      userMessage: titleInput,
    });
    const titleOp = titleHandle.promise
      .then(async (title) => {
        if (!title) return;

        await ctx.storage.threads.update(threadId, { title }).catch((error) => {
          console.error(
            "[decopilot:stream] Error updating thread title",
            error,
          );
        });

        // Notify subscribers outside the per-thread /stream (other tabs,
        // panels). Best-effort: a publish failure must not break the run.
        try {
          await onTitleUpdated?.(title);
        } catch (err) {
          console.error(
            "[decopilot:stream] onTitleUpdated callback failed",
            err,
          );
        }

        if (!isStreamFinished()) {
          chunkQueue.push({
            type: "data-thread-title",
            data: { title },
            transient: true,
          });
          console.log(
            "[decopilot:title-debug] SSE title event sent threadId=%s",
            threadId,
          );
        } else {
          console.warn(
            "[decopilot:title-debug] Stream already finished, title SSE NOT sent threadId=%s title=%j",
            threadId,
            title,
          );
        }
      })
      .catch((error) => {
        console.warn("[decopilot:stream] Title generation failed:", error);
      });
    registerPendingOp(titleOp);
  }

  // ── Mode + tool gating state shared between prepareStep and the
  //    `tools` argument to streamText ───────────────────────────────
  let reasoningStartAt: Date | null = null;
  // NOTE: stream-core also tracks `codingAgentSessionId` /
  // `codingAgentProvider` for the claude-code / codex `finish-step`
  // provider-metadata, but those providers run in their own harnesses
  // (Tasks 9 + 10), so the values are always undefined here and the
  // tracking has been dropped.
  //
  // Cumulative usage / cache-token / OpenRouter-cost tracking lives in
  // a shared accumulator (`../usage-accumulator`) used by all three
  // harnesses so the emitted `messageMetadata.usage` shape stays
  // identical. The accumulator surfaces `totalTokens()` /
  // `cacheTotals()` for OTel attrs + abort metrics readers below.
  const usageAcc = createUsageAccumulator();
  llmCallStartTime = Date.now();

  const passthroughToolNames = new Set(Object.keys(tools.passthroughTools));
  const builtInToolNames = Object.keys(tools.builtInTools);
  const enabledTools = reconstructEnabledTools(
    originalMessages,
    passthroughToolNames,
  );

  // Anthropic prompt-cache invariant: the cache key for our system
  // block markers is hash(tools + system_prefix), so the serialized
  // `tools` JSON must be byte-stable across calls that should hit the
  // cache. We rely on object-spread insertion order being deterministic
  // here. `withCachedToolPrefix` (which sorts + marks) is intentionally
  // NOT applied because `enable_tool` mutates the toolset across
  // subsequent LLM calls in the same turn — any tool-prefix marker
  // would invalidate on the next call anyway.
  const streamTools: ToolSet = {
    ...tools.tools,
    ...(tools.connectionsBlockTools.length > 0
      ? {
          enable_tool: createEnableToolTool(
            enabledTools,
            passthroughToolNames,
            {
              isPlanMode: modeConfig.isPlanMode,
              toolAnnotations: tools.toolAnnotations,
              connectionIds: [...tools.connectionIds],
            },
          ),
        }
      : {}),
  };

  // ── Span: manually managed because it starts here but ends async
  //    in onFinish / onError. ───────────────────────────────────────
  const llmSpan = tracer.startSpan("decopilot.streamText", {
    attributes: {
      "decopilot.model.id": input.models.thinking.id,
      "decopilot.credential.id": input.models.credentialId,
      "decopilot.isCliAgent": false,
      "decopilot.isCodex": false,
    },
  });

  const languageModel = createLanguageModel(provider, input.models.thinking);

  let result;
  try {
    result = streamText({
      model: languageModel,
      system: [...prompt.systemMessages, ...processedSystemMessages],
      messages: processedMessages,
      tools: streamTools,
      providerOptions: OPENROUTER_CACHE_PROVIDER_OPTIONS,
      prepareStep: (() => {
        const forcedFirstStepToolName =
          modeConfig.forcedFirstStepTool &&
          modeConfig.forcedFirstStepTool in streamTools
            ? modeConfig.forcedFirstStepTool
            : null;
        let stepIndex = 0;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (stepArgs: any) => {
          const stepMessages = stepArgs.messages;
          const isFirstStep = stepIndex === 0;
          stepIndex++;

          // Inject pending screenshot images as a user message.
          // Images in tool result messages aren't supported by all
          // providers (e.g. OpenRouter), so we append them as user
          // content which is universally supported.
          // biome-ignore lint: complex AI SDK generic types
          let withImages: any = stepMessages;
          const pendingImages = extras.pendingImages;
          if (pendingImages.length > 0) {
            const imageParts = pendingImages.splice(0, pendingImages.length);
            const content: unknown[] = [];
            for (const img of imageParts) {
              content.push({
                type: "text",
                text:
                  img.label ??
                  (img.pageUrl ? `[Screenshot of ${img.pageUrl}]` : "[Image]"),
              });
              if (img.url.startsWith("data:")) {
                // data URI → send as inline image
                const match = img.url.match(/^data:([^;]+);base64,(.+)$/s);
                if (match) {
                  content.push({
                    type: "image",
                    image: match[2],
                    mimeType: match[1],
                  });
                }
              } else {
                // Presigned URL → send as image URL
                content.push({
                  type: "image",
                  image: new URL(img.url),
                });
              }
            }
            withImages = [...stepMessages, { role: "user", content }];
          }

          // Intra-loop todo_write strip + inject has been removed. The
          // agent sees its own todo_write tool calls live inside the
          // agent loop. Cross-turn pruning to keep only the most recent
          // todo_write call/result pair happens once at HTTP entry via
          // `processConversation` → `keepLastTodoWrite`. The step
          // messages here are the raw post-image-injection stream.
          const messagesForStep = withImages;

          const hasEnableTool = tools.connectionsBlockTools.length > 0;
          let activeToolNames = [
            ...builtInToolNames,
            ...(hasEnableTool ? ["enable_tool"] : []),
            ...enabledTools,
          ];

          // Layer 2: In plan mode, filter out any non-read-only tools that
          // somehow got enabled (safety net for Layer 1 in enable_tool)
          if (modeConfig.isPlanMode) {
            activeToolNames = activeToolNames.filter((name) => {
              // Built-in tools and enable_tool are always allowed
              if (
                builtInToolNames.includes(name) ||
                (hasEnableTool && name === "enable_tool")
              ) {
                return true;
              }
              // Only allow passthrough tools with readOnlyHint
              const annotations = tools.toolAnnotations.get(name);
              return annotations?.readOnlyHint === true;
            });
          }

          const forcedToolName =
            forcedFirstStepToolName && isFirstStep
              ? forcedFirstStepToolName
              : null;

          return {
            activeTools: activeToolNames as (keyof typeof streamTools)[],
            messages: messagesForStep,
            ...(forcedToolName && {
              toolChoice: {
                type: "tool" as const,
                toolName: forcedToolName as never,
              },
            }),
          };
        };
      })(),
      temperature: input.temperature,
      maxOutputTokens,
      stopWhen: stepCountIs(PARENT_STEP_LIMIT),
      abortSignal: registrySignal,
      onFinish: async ({
        usage,
        totalUsage,
        finishReason,
        request,
        response,
      }) => {
        llmSpan.setAttribute(
          "decopilot.llm.inputTokens",
          totalUsage.inputTokens ?? 0,
        );
        llmSpan.setAttribute(
          "decopilot.llm.outputTokens",
          totalUsage.outputTokens ?? 0,
        );
        llmSpan.setAttribute("decopilot.llm.finishReason", finishReason);
        const cacheTotals = usageAcc.cacheTotals();
        llmSpan.setAttribute("decopilot.cache.read_tokens", cacheTotals.read);
        llmSpan.setAttribute("decopilot.cache.write_tokens", cacheTotals.write);
        const hitRatio =
          cacheTotals.input > 0 ? cacheTotals.read / cacheTotals.input : 0;
        llmSpan.setAttribute("decopilot.cache.hit_ratio", hitRatio);
        llmSpan.setStatus({ code: SpanStatusCode.OK });
        llmSpan.end();

        // Always record usage even on abort — tokens were already consumed.
        const durationMs = Date.now() - (llmCallStartTime ?? Date.now());
        llmCallLogged = true;
        recordLlmCallMetrics({
          ctx,
          organizationId: input.organizationId,
          modelId: input.models.thinking.id,
          durationMs,
          isError: false,
          inputTokens: totalUsage.inputTokens,
          outputTokens: totalUsage.outputTokens,
          cacheReadTokens: cacheTotals.read,
          cacheWriteTokens: cacheTotals.write,
        });
        extras.onUsageAggregated({
          inputTokens: totalUsage.inputTokens ?? 0,
          outputTokens: totalUsage.outputTokens ?? 0,
          totalTokens: totalUsage.totalTokens ?? 0,
        });
        monitorLlmCall({
          ctx,
          organizationId: input.organizationId,
          agentId: input.agent.id,
          modelId: input.models.thinking.id,
          modelTitle: input.models.thinking.title ?? input.models.thinking.id,
          credentialId: input.models.credentialId,
          taskId: threadId,
          durationMs,
          isError: false,
          finishReason,
          usage: {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0,
          },
          totalUsage: {
            inputTokens: totalUsage.inputTokens ?? 0,
            outputTokens: totalUsage.outputTokens ?? 0,
            totalTokens: totalUsage.totalTokens ?? 0,
          },
          request,
          response,
          userId: input.user.id,
          requestId: ctx.metadata.requestId,
          userAgent: ctx.metadata.userAgent ?? null,
        });

        if (registrySignal.aborted) return;
      },
      onError: async (error) => {
        const err =
          error instanceof Error ? error : new Error(stringifyError(error));
        llmSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: err.message,
        });
        llmSpan.recordException(err);
        llmSpan.end();

        console.error("[decopilot:stream] Error", error);
        if (registrySignal.aborted) {
          throw error;
        }
        if (!llmCallLogged) {
          const durationMs = Date.now() - (llmCallStartTime ?? Date.now());
          llmCallLogged = true;
          recordLlmCallMetrics({
            ctx,
            organizationId: input.organizationId,
            modelId: input.models.thinking.id,
            durationMs,
            isError: true,
            errorType: error instanceof Error ? error.name : "Error",
          });
          monitorLlmCall({
            ctx,
            organizationId: input.organizationId,
            agentId: input.agent.id,
            modelId: input.models.thinking.id,
            modelTitle: input.models.thinking.title ?? input.models.thinking.id,
            credentialId: input.models.credentialId,
            taskId: threadId,
            durationMs,
            isError: true,
            errorMessage:
              error instanceof Error ? error.message : stringifyError(error),
            userId: input.user.id,
            requestId: ctx.metadata.requestId,
            userAgent: ctx.metadata.userAgent ?? null,
          });
        }
        throw error;
      },
      onAbort: async ({ steps }) => {
        if (!steps.length || llmCallLogged) return;
        llmCallLogged = true;
        const durationMs = Date.now() - (llmCallStartTime ?? Date.now());
        const abortTotalUsage = steps.reduce(
          (acc, s) => ({
            inputTokens: acc.inputTokens + (s.usage.inputTokens ?? 0),
            outputTokens: acc.outputTokens + (s.usage.outputTokens ?? 0),
            totalTokens: acc.totalTokens + (s.usage.totalTokens ?? 0),
          }),
          { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        );
        const lastStepUsage = steps[steps.length - 1]!.usage;
        const cacheTotalsOnAbort = usageAcc.cacheTotals();
        recordLlmCallMetrics({
          ctx,
          organizationId: input.organizationId,
          modelId: input.models.thinking.id,
          durationMs,
          isError: false,
          inputTokens: abortTotalUsage.inputTokens,
          outputTokens: abortTotalUsage.outputTokens,
          cacheReadTokens: cacheTotalsOnAbort.read,
          cacheWriteTokens: cacheTotalsOnAbort.write,
        });
        monitorLlmCall({
          ctx,
          organizationId: input.organizationId,
          agentId: input.agent.id,
          modelId: input.models.thinking.id,
          modelTitle: input.models.thinking.title ?? input.models.thinking.id,
          credentialId: input.models.credentialId,
          taskId: threadId,
          durationMs,
          isError: false,
          finishReason: "abort",
          usage: {
            inputTokens: lastStepUsage.inputTokens ?? 0,
            outputTokens: lastStepUsage.outputTokens ?? 0,
            totalTokens: lastStepUsage.totalTokens ?? 0,
          },
          totalUsage: abortTotalUsage,
          request: undefined,
          response: undefined,
          userId: input.user.id,
          requestId: ctx.metadata.requestId,
          userAgent: ctx.metadata.userAgent ?? null,
        });

        // Re-push accumulated usage to the client. On abort the SDK
        // resets message.metadata to its pre-stream state, so we
        // explicitly emit it here before the stream closes.
        if (abortTotalUsage.totalTokens > 0) {
          const cost = usageAcc.cost();
          chunkQueue.push({
            type: "message-metadata",
            messageMetadata: {
              usage: {
                inputTokens: abortTotalUsage.inputTokens,
                outputTokens: abortTotalUsage.outputTokens,
                totalTokens: abortTotalUsage.totalTokens,
                cachedInputTokens: cacheTotalsOnAbort.read,
                inputTokenDetails: {
                  cacheReadTokens: cacheTotalsOnAbort.read,
                  cacheWriteTokens: cacheTotalsOnAbort.write,
                  noCacheTokens:
                    abortTotalUsage.inputTokens -
                    cacheTotalsOnAbort.read -
                    cacheTotalsOnAbort.write,
                },
                ...(cost > 0 && {
                  providerMetadata: {
                    openrouter: {
                      usage: { cost },
                    },
                  },
                }),
              },
            },
          });
        }
      },
    });
  } catch (err) {
    llmSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : stringifyError(err),
    });
    if (err instanceof Error) llmSpan.recordException(err);
    llmSpan.end();
    throw err;
  }

  // Posthog: emit `chat_message_completed`/`chat_message_aborted`/
  // `chat_message_failed` is the caller's responsibility (it lives in
  // the outer `createUIMessageStream.onFinish`/`onError`, which sees
  // the full UI-message-stream lifecycle including the final
  // responseMessage). The helper only owns the streamText layer.

  // ── UIMessage stream + side-channel queue, drained concurrently ──
  const uiMessageStream = result.toUIMessageStream({
    originalMessages,
    generateMessageId,
    onError: (error) => sanitizeStreamError(error),
    messageMetadata: ({ part }) => {
      if (part.type === "start") {
        return {
          agent: {
            id: input.agent.id ?? null,
          },
          models: {
            credentialId: input.models.credentialId,
            thinking: {
              ...input.models.thinking,
              title: input.models.thinking.title ?? input.models.thinking.id,
              provider: input.models.thinking.provider ?? undefined,
            },
          },
          created_at: new Date(),
          _request: {
            systemSections: prompt.systemMessages.map((p) => ({
              chars: p.content.length,
              preview: p.content.slice(0, 80).replace(/\s+/g, " "),
            })),
            tools: Object.keys(streamTools).length,
            activeTools:
              builtInToolNames.length +
              ("enable_tool" in streamTools ? 1 : 0) +
              enabledTools.size,
          },
          thread_id: threadId,
        };
      }
      if (part.type === "reasoning-start") {
        if (reasoningStartAt === null) {
          reasoningStartAt = new Date();
        }
        return { reasoning_start_at: reasoningStartAt };
      }
      if (part.type === "reasoning-end") {
        return { reasoning_end_at: new Date() };
      }

      if (part.type === "finish-step") {
        // (claude-code / codex provider-metadata extraction lives in
        // the CLI harness — not relevant here.)
        usageAcc.addStep(part.usage, part.providerMetadata);
        return { usage: usageAcc.buildStepUsage() };
      }

      if (part.type === "finish") {
        const usage = usageAcc.buildFinalUsage({
          totalUsage: part.totalUsage,
          providerKey: input.models.thinking.provider,
          // Safety net: the SDK exposes `providerMetadata` on the
          // `finish` chunk itself when no `finish-step` ever fired
          // (0-step stream). Mirrors pre-refactor stream-core's
          // `lastProviderMetadata ?? part.providerMetadata` fallback.
          fallbackProviderMetadata: (
            part as { providerMetadata?: Record<string, unknown> }
          ).providerMetadata,
        });
        return usage ? { usage } : {};
      }

      return;
    },
  });

  // Drain the uiMessageStream and the side-channel queue concurrently.
  // Both `mainPromise` and `queuePromise` are held across loop
  // iterations — re-armed only after the corresponding source produces
  // a value — so we never lose chunks. The queue is a strict single-
  // consumer primitive (one `waiter` slot), so creating a second
  // pending `next()` would leak the first one's resolver; persisting
  // the outstanding promise is mandatory.
  type Settled =
    | { kind: "main"; value: IteratorResult<UIMessageChunk> }
    | {
        kind: "queue";
        value: { done: false; value: UIMessageChunk } | { done: true };
      };
  const iter = uiMessageStream[Symbol.asyncIterator]();
  let mainPromise: Promise<Settled> = iter
    .next()
    .then((v) => ({ kind: "main" as const, value: v }));
  let queuePromise: Promise<Settled> = chunkQueue
    .next()
    .then((v) => ({ kind: "queue" as const, value: v }));
  try {
    while (true) {
      const settled = await Promise.race([mainPromise, queuePromise]);
      if (settled.kind === "main") {
        if (settled.value.done) {
          // Main stream finished. Close the queue so the outstanding
          // queue waiter resolves with `done: true`, then drain any
          // remaining buffered chunks (the abort-time
          // `message-metadata` chunk in particular fires synchronously
          // inside `onAbort` and may already be sitting in the queue
          // at this point).
          chunkQueue.close();
          // Drain in lockstep: each `chunkQueue.next()` either returns
          // the next buffered chunk or `done: true` (the queue is
          // closed and the buffer is empty).
          while (true) {
            const remaining = await chunkQueue.next();
            if (remaining.done) break;
            yield remaining.value;
          }
          break;
        }
        yield settled.value.value;
        mainPromise = iter
          .next()
          .then((v) => ({ kind: "main" as const, value: v }));
      } else {
        // Queue-side resolution. The queue is only closed by us
        // (inside the main-done branch above), so a `done: true`
        // here is unreachable during the main loop — the loop has
        // already broken in that case.
        if (!settled.value.done) {
          yield settled.value.value;
        }
        queuePromise = chunkQueue
          .next()
          .then((v) => ({ kind: "queue" as const, value: v }));
      }
    }
  } finally {
    // Defensive: make sure the queue is closed so any callback fired
    // after we exit can't hang the consumer.
    chunkQueue.close();
    // Signal to the title-gen helper that the main stream is done.
    // Starts its 10s grace period before aborting — mirroring the
    // outer onFinish/onError handlers in the inline original.
    titleHandle?.finish();
  }

  // Note about posthog: the original `chat_message_completed` /
  // `chat_message_failed` / `chat_message_aborted` events are emitted
  // from the outer `createUIMessageStream` onFinish/onError, because
  // they need the final `responseMessage` (assembled by the UI-message
  // stream layer, not by streamText). They stay in the caller.
}

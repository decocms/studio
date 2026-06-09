/**
 * runDecopilotStream
 *
 * The decopilot harness's streamText loop, extracted from
 * `stream-core.ts` (~lines 780–1582) into a standalone async generator.
 * Owns:
 *  - Background title generation with the harness fast model, kicked off in
 *    parallel with the main LLM stream.
 *  - `streamText` invocation with the full set of callbacks: `prepareStep`
 *    (todo-write strip + inject, image injection, plan-mode tool gating,
 *    forced-first-step toolChoice), `onFinish`/`onError`/`onAbort`
 *    (LLM-call metrics + monitoring, otel span lifecycle).
 *  - `result.toUIMessageStream({ messageMetadata })` chunk producer that
 *    decorates chunks with start/step/finish metadata (model id, usage,
 *    cache token details, coding-agent session ids).
 *  - Auto-title result emission (`data-title-result`) — yielded through the
 *    same async iterator as the main stream chunks. The dispatch interceptor
 *    persists it and writes the UI-facing `data-thread-title` chunk.
 *  - Abort-time `message-metadata` re-emission so the UI keeps the
 *    accumulated usage that the SDK would otherwise reset to its
 *    pre-stream state.
 *
 * The helper is intentionally CLI-agent-free — the claude-code / codex
 * branches that live inline in `stream-core.ts` belong to their own
 * harnesses (see Tasks 9 + 10). Everything here assumes a regular provider
 * surface reconstructed from a resolved Decopilot model source and the full
 * tool set assembled by `assembleDecopilotTools`.
 *
 * Today this code lives inline inside `stream-core.ts`; the helper here
 * is unused until Task 12 wires it through the harness factory. Behavior
 * is intended to be byte-for-byte the same as the inline version.
 *
 * Important difference from the inline original: the original calls
 * `writer.write(chunk)` from `onAbort` to push side-channel chunks into the
 * merged UI message stream. The async-generator shape doesn't have a writer
 * to call back into, so this module hosts a tiny internal queue: callbacks
 * push chunks onto it, and the main yield loop drains it alongside the
 * `toUIMessageStream` output.
 */

import type { StudioContext, OrganizationScope } from "@/core/studio-context";
import { monitorLlmCall } from "@/monitoring/emit-llm-call";
import { recordLlmCallMetrics } from "@/monitoring/record-llm-call-metrics";
import {
  type ModelMessage,
  type StreamTextOnStepFinishCallback,
  type SystemModelMessage,
  type ToolSet,
  type UIMessageChunk,
  type UIMessageStreamWriter,
} from "ai";
import type { MeshProvider } from "@/ai-providers/types";

import { createEnableToolTool } from "./built-in-tools/enable-tool";
import type { PendingImage } from "./built-in-tools";
import { createUsageAccumulator } from "../usage-accumulator";
import { generateMessageId } from "../../api/routes/decopilot/constants";
import { resolveModeConfig } from "../../api/routes/decopilot/mode-config";
import { makeTitleResultChunk } from "../title-chunk";
import { createLanguageModel } from "@/ai-providers/language-model";
import { genTitle } from "./title-generator";
import type { ChatMessage, ModelInfo } from "../../api/routes/decopilot/types";
import type { HarnessStreamInput } from "../types";
import type { AssembledTools } from "./tools";
import type { AssembledPrompt } from "./prompt";
import { sanitizeStreamError, stringifyError } from "./stream-error";
import { runAgentLoop } from "./run-agent-loop";
import { isDecopilot } from "@decocms/mesh-sdk";
import {
  createAgentPrepareStep,
  reconstructEnabledTools,
} from "./agent-loop-state";

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

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
   * Provider reconstructed from `input.modelSources.primary`. Decopilot,
   * unlike CLI harnesses, always has a provider.
   */
  provider: MeshProvider;

  /** Provider/model used only for title generation. This lets Decopilot use
   *  the org fast tier even when the main chat model uses another tier or
   *  credential. */
  titleProvider?: MeshProvider | null;
  titleModel?: ModelInfo | null;

  /**
   * Run-registry abort signal for this run. Listened to by streamText
   * (`abortSignal`), by genTitle (`abortSignal`), and queried from
   * `onFinish`/`onAbort` callbacks to distinguish a real model finish
   * from a user-cancel.
   *
   * Source: `HarnessStreamInput.signal`. Hosted dispatch wires this to
   * `runRegistry.getAbortSignal(mem.thread.id)`; remote runners receive their
   * equivalent transport abort signal.
   */
  registrySignal: AbortSignal;

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
   * UIMessageStreamWriter forwarded from the outer createUIMessageStream.
   * Required by `runAgentLoop` → `assembleAgentTools` for streaming tool
   * output from built-in tools (subtask, generate_image, etc.).
   *
   * Source: the `writer` arg injected into the `createUIMessageStream`
   * execute callback in dispatch-run.ts; forwarded here so runAgentLoop
   * can own tool assembly internally.
   */
  writer: UIMessageStreamWriter;

  /**
   * Tool side-channel chunks emitted by the harness-owned writer. Cluster and
   * desktop Decopilot both expose built-in tool metadata this way, while Studio
   * consumes the resulting UIMessageChunk stream uniformly.
   */
  sideChunks?: AsyncIterable<UIMessageChunk>;
  closeSideChunks?: () => void;
  onStepFinish?: StreamTextOnStepFinishCallback<ToolSet>;
}

// ─────────────────────────────────────────────────────────────────────
// Async-queue plumbing
// ─────────────────────────────────────────────────────────────────────

/**
 * Tiny single-producer, single-consumer chunk queue used to merge
 * side-channel chunks (today: abort-time `message-metadata` and the
 * abort-time `message-metadata`) into the main `for await` iteration
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
 * work before closing.
 *
 * Side-channel chunks are pushed onto an internal queue and interleaved into
 * the main yield loop, matching the inline `writer.write` semantics
 * byte-for-byte.
 */
export async function* runDecopilotStream(
  input: HarnessStreamInput,
  ctx: StudioContext,
  tools: AssembledTools,
  prompt: AssembledPrompt,
  extras: RunDecopilotStreamExtras,
): AsyncGenerator<UIMessageChunk> {
  const {
    provider,
    titleProvider,
    titleModel,
    registrySignal,
    processedSystemMessages,
    processedMessages,
    originalMessages,
    threadId,
    writer,
  } = extras;

  const modeConfig = resolveModeConfig(input.mode, { isCliAgent: false });
  let llmCallStartTime: number | undefined;
  let llmCallLogged = false;

  // Side-channel chunk queue — see `makeChunkQueue` jsdoc for why.
  const chunkQueue = makeChunkQueue();

  // ── Auto-title: generate with this harness's fast model. The cluster
  //    interceptor only persists/broadcasts the generated result.
  const userMessageText = JSON.stringify(processedMessages[0]?.content ?? "");
  const titleHandle = genTitle({
    abortSignal: registrySignal,
    model: createLanguageModel(
      titleProvider ?? provider,
      titleModel ?? input.models.fast ?? input.models.thinking,
    ) as never,
    userMessage: userMessageText,
  });
  const titlePromise = titleHandle.promise
    .then((title) => {
      return title ? (makeTitleResultChunk(title) as UIMessageChunk) : null;
    })
    .catch((err) => {
      console.warn(
        "[decopilot:title] title generation failed",
        stringifyError(err),
      );
      return null;
    });

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
            },
          ),
        }
      : {}),
  };

  const parentPrepareStep = createAgentPrepareStep({
    modeConfig,
    streamTools,
    builtInToolNames,
    enabledTools,
    toolAnnotations: tools.toolAnnotations,
    pendingImages: extras.pendingImages,
    hasEnableTool: tools.connectionsBlockTools.length > 0,
  });

  // Non-cached system tail telling the model exactly which tools it has
  // already enabled this thread. Lives outside the cached prefix so it
  // can vary per-turn without invalidating Anthropic cache breakpoints.
  // Bridges the gap between the static `<available-connections>` block
  // (cached, state-free) and the model's actual `activeTools` list, so
  // the model doesn't re-call `enable_tool` for tools it already enabled
  // earlier in the conversation.
  const enabledToolsSystemMessage =
    enabledTools.size > 0
      ? {
          role: "system" as const,
          content: `<currently-enabled-tools>\n${[...enabledTools]
            .sort()
            .join("\n")}\n</currently-enabled-tools>`,
        }
      : null;

  // ── Call runAgentLoop ─────────────────────────────────────────────
  // Stage 2: runAgentLoop owns system-prompt + tool assembly internally.
  // The parent still passes:
  //   - `passthroughClient`  → for the prompts block in the system prompt
  //   - `connectionsData`    → for the connections block in the system prompt
  //   - `extraTools`         → enable_tool (state-dependent, built above)
  //   - `prepareStep`        → image injection + plan-mode filter
  //   - `additionalSystemMessages` → per-request inline <system> blocks
  // The OLD `__tools`, `__system`, `__prepareStep` shims are gone.
  const vmMetadata = input.virtualMcp.metadata as {
    githubRepo?: import("@decocms/mesh-sdk").GithubRepo | null;
  };
  const handle = await runAgentLoop({
    kind: "agent",
    ctx,
    organization: { id: input.organizationId } as OrganizationScope,
    virtualMcp: {
      id: input.agent.id,
      repo: vmMetadata?.githubRepo ?? undefined,
    },
    mcpClient: tools.passthroughClient as never,
    provider,
    models: input.models,
    messages: processedMessages,
    abortSignal: registrySignal,
    temperature: input.temperature,
    planMode: modeConfig.isPlanMode,
    isDecopilot: isDecopilot(input.agent.id) !== null,
    systemAgentInstructions: tools.serverInstructions,
    currentThreadId: threadId,
    writer,
    subtaskParams: {
      provider,
      organization: { id: input.organizationId } as OrganizationScope,
      models: input.models,
    },
    prepareStep: parentPrepareStep,
    onStepFinish: extras.onStepFinish,
    passthroughClient: tools.passthroughClient as never,
    connectionsData: {
      tools: tools.connectionsBlockTools,
      connectionTitleMap: tools.connectionTitleMap,
    },
    // Pass the full parent built-ins (heavy tools: VM, web_search, screenshot,
    // etc.) as extraTools so runAgentLoop's assembleAgentTools (lightweight)
    // gets overridden with the complete set. Also inject enable_tool, which
    // is state-dependent (built from enabledTools reconstructed above).
    extraTools: {
      ...(tools.builtInTools as ToolSet),
      ...(tools.connectionsBlockTools.length > 0 && streamTools.enable_tool
        ? { enable_tool: streamTools.enable_tool }
        : {}),
    },
    additionalSystemMessages: [
      ...processedSystemMessages,
      ...(enabledToolsSystemMessage ? [enabledToolsSystemMessage] : []),
    ],
  });

  const result = handle.result;

  // ── Parent's own metrics/monitoring around the result.
  //    These were previously inline in the streamText({...}) callbacks.
  //    Now they're Promise-based, attached to result.finishReason /
  //    handle.error.
  const finishMetricsPromise = Promise.resolve(result.finishReason)
    .then(async (finishReason) => {
      const [totalUsage, usage, request, response] = await Promise.all([
        result.totalUsage,
        result.usage,
        result.request,
        result.response,
      ]);
      // If there was an error, the onError path below handles metrics.
      // onFinish fires even on error in some SDK versions; guard with
      // the error handle to avoid double-logging.
      const capturedErr = await handle.error;
      if (capturedErr !== undefined) return;

      // OTel attrs on the runAgentLoop span (handle.span)
      handle.span.setAttribute(
        "decopilot.llm.inputTokens",
        totalUsage.inputTokens ?? 0,
      );
      handle.span.setAttribute(
        "decopilot.llm.outputTokens",
        totalUsage.outputTokens ?? 0,
      );
      handle.span.setAttribute("decopilot.llm.finishReason", finishReason);
      const cacheTotals = usageAcc.cacheTotals();
      handle.span.setAttribute("decopilot.cache.read_tokens", cacheTotals.read);
      handle.span.setAttribute(
        "decopilot.cache.write_tokens",
        cacheTotals.write,
      );
      const hitRatio =
        cacheTotals.input > 0 ? cacheTotals.read / cacheTotals.input : 0;
      handle.span.setAttribute("decopilot.cache.hit_ratio", hitRatio);

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
        cost: usageAcc.cost(),
        request,
        response,
        userId: input.user.id,
        requestId: ctx.metadata.requestId,
        userAgent: ctx.metadata.userAgent ?? null,
      });

      if (registrySignal.aborted) return;
    })
    .catch(async (error) => {
      // error path — finishReason promise itself rejected OR we got here
      // from a provider error. runAgentLoop's onError fires first and
      // sets handle.error; we pick up the message from there.
      const rawError =
        error instanceof Error ? error : new Error(stringifyError(error));
      console.error("[decopilot:stream] Error", rawError.message);
      if (registrySignal.aborted) {
        return;
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
          errorType: rawError.name,
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
          errorMessage: rawError.message,
          userId: input.user.id,
          requestId: ctx.metadata.requestId,
          userAgent: ctx.metadata.userAgent ?? null,
        });
      }
    });
  const finishMetricsDonePromise = finishMetricsPromise.catch((err) => {
    console.error("[decopilot:stream] finish metrics failed", err);
  });

  // onAbort path: the old code's onAbort fires when steps.length > 0
  // and llmCallLogged is false. We re-implement this by watching
  // handle.error AND registrySignal.aborted.
  // The SDK's onAbort fires synchronously before the stream drains, so
  // we must register this watcher before we start draining the stream below.
  // It resolves to an optional metadata chunk that is merged alongside title
  // and side-channel chunks so abort usage is not lost after the main stream
  // closes.
  const abortMetadataPromise = handle.error.then(async (_errMsg) => {
    // Only fire the abort metrics path if the signal was aborted AND
    // we haven't already logged metrics via the onFinish path.
    if (!registrySignal.aborted || llmCallLogged) return null;
    const steps = await result.steps;
    if (!steps.length || llmCallLogged) return null;
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
      cost: usageAcc.cost(),
      request: undefined,
      response: undefined,
      userId: input.user.id,
      requestId: ctx.metadata.requestId,
      userAgent: ctx.metadata.userAgent ?? null,
    });

    // Re-push accumulated usage to the client. On abort the SDK
    // resets message.metadata to its pre-stream state, so we
    // explicitly emit it here before the stream closes.
    if (abortTotalUsage.totalTokens <= 0) return null;

    const cost = usageAcc.cost();
    return {
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
    } satisfies UIMessageChunk;
  });

  const abortMetadataResultPromise = abortMetadataPromise
    .then((chunk) => chunk)
    .catch((err) => {
      console.error("[decopilot:stream] abort metadata failed", err);
      return null;
    });

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

  // Drain the uiMessageStream and side-channel queues concurrently.
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
      }
    | { kind: "side"; value: IteratorResult<UIMessageChunk> }
    | { kind: "finish-metrics" }
    | { kind: "abort-metadata"; value: UIMessageChunk | null }
    | { kind: "title"; value: UIMessageChunk | null };
  const iter = uiMessageStream[Symbol.asyncIterator]();
  const sideIter = extras.sideChunks?.[Symbol.asyncIterator]();
  let mainDone = false;
  let titleDone = false;
  let finishMetricsDone = false;
  let abortMetadataDone = false;
  let queueDone = false;
  let sideDone = sideIter === undefined;
  let sideCloseRequested = false;
  let mainPromise: Promise<Settled> = iter
    .next()
    .then((v) => ({ kind: "main" as const, value: v }));
  let queuePromise: Promise<Settled> = chunkQueue
    .next()
    .then((v) => ({ kind: "queue" as const, value: v }));
  let sidePromise: Promise<Settled> | null = sideIter
    ? sideIter.next().then((value) => ({ kind: "side" as const, value }))
    : null;
  const titleResultPromise: Promise<Settled> = titlePromise.then((value) => ({
    kind: "title" as const,
    value,
  }));
  const finishMetricsSettledPromise: Promise<Settled> =
    finishMetricsDonePromise.then(() => ({ kind: "finish-metrics" as const }));
  const abortMetadataSettledPromise: Promise<Settled> =
    abortMetadataResultPromise.then((value) => ({
      kind: "abort-metadata" as const,
      value,
    }));
  try {
    while (
      !mainDone ||
      !titleDone ||
      !finishMetricsDone ||
      !abortMetadataDone ||
      !queueDone ||
      !sideDone
    ) {
      if (
        mainDone &&
        titleDone &&
        finishMetricsDone &&
        abortMetadataDone &&
        !sideCloseRequested
      ) {
        // Main stream and title generation are both settled. Close the
        // side-channel producers, then keep servicing the already-outstanding
        // queue/side promises until both report done. Reusing those promises is
        // important: a resolved-but-not-yet-raced promise may already hold a
        // chunk that a fresh next() call would skip.
        extras.closeSideChunks?.();
        chunkQueue.close();
        sideCloseRequested = true;
      }

      const pending: Promise<Settled>[] = [];
      if (!queueDone) pending.push(queuePromise);
      if (!mainDone) pending.push(mainPromise);
      if (!titleDone) pending.push(titleResultPromise);
      if (!finishMetricsDone) pending.push(finishMetricsSettledPromise);
      if (!abortMetadataDone) pending.push(abortMetadataSettledPromise);
      if (!sideDone && sidePromise) pending.push(sidePromise);

      const settled = await Promise.race(pending);
      if (settled.kind === "main") {
        if (settled.value.done) {
          mainDone = true;
          if (!titleDone) {
            titleHandle.finish();
          }
          continue;
        }
        yield settled.value.value;
        mainPromise = iter
          .next()
          .then((v) => ({ kind: "main" as const, value: v }));
      } else if (settled.kind === "title") {
        titleDone = true;
        if (settled.value) yield settled.value;
      } else if (settled.kind === "finish-metrics") {
        finishMetricsDone = true;
      } else if (settled.kind === "abort-metadata") {
        abortMetadataDone = true;
        if (settled.value) yield settled.value;
      } else if (settled.kind === "side") {
        if (settled.value.done) {
          sideDone = true;
          continue;
        }
        yield settled.value.value;
        sidePromise =
          sideIter
            ?.next()
            .then((value) => ({ kind: "side" as const, value })) ?? null;
      } else {
        if (settled.value.done) {
          queueDone = true;
          continue;
        }
        yield settled.value.value;
        queuePromise = chunkQueue
          .next()
          .then((v) => ({ kind: "queue" as const, value: v }));
      }
    }
  } finally {
    // Defensive: make sure the queue is closed so any callback fired
    // after we exit can't hang the consumer.
    if (!titleDone) titleHandle.finish();
    extras.closeSideChunks?.();
    await iter.return?.().catch(() => {});
    await sideIter?.return?.().catch(() => {});
    chunkQueue.close();
  }

  // Note about posthog: the original `chat_message_completed` /
  // `chat_message_failed` / `chat_message_aborted` events are emitted
  // from the outer `createUIMessageStream` onFinish/onError, because
  // they need the final `responseMessage` (assembled by the UI-message
  // stream layer, not by streamText). They stay in the caller.
}

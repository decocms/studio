/**
 * runDecopilotStream
 *
 * The decopilot harness's streamText loop. The portable engine layer of the
 * shared Decopilot core: it builds the enable_tool / prepareStep / enabled-tool
 * state, drives the env engine through the injected `runEngine` adapter
 * (`runAgentLoop` on the cluster, `runNativeAgentLoopCore` on the desktop in
 * Task 15), and owns:
 *  - Background title generation with the harness fast model, kicked off in
 *    parallel with the main LLM stream.
 *  - `result.toUIMessageStream({ messageMetadata })` chunk producer that
 *    decorates chunks with start/step/finish metadata (model id, usage,
 *    cache token details).
 *  - LLM-call telemetry fired through the injected `telemetry` hooks
 *    (cluster: monitoring + metrics; desktop: no-op).
 *  - Auto-title result emission (`data-title-result`) — yielded through the
 *    same async iterator as the main stream chunks.
 *  - Abort-time `message-metadata` re-emission so the UI keeps the accumulated
 *    usage that the SDK would otherwise reset.
 *
 * This module is `@/*`-free so the daemon can bundle it. Cluster-only
 * monitoring lives behind the `telemetry` hooks; ctx-coupled engine assembly
 * lives behind `runEngine`.
 *
 * Side-channel chunks are pushed onto an internal queue: callbacks push chunks
 * onto it, and the main yield loop drains it alongside the `toUIMessageStream`
 * output.
 */

import {
  type ModelMessage,
  type StreamTextOnStepFinishCallback,
  type SystemModelMessage,
  type ToolSet,
  type UIMessageChunk,
  type UIMessageStreamWriter,
} from "ai";
import type { StudioProvider } from "./studio-provider";

import { createEnableToolTool } from "./built-in-tools/enable-tool";
import {
  createUsageAccumulator,
  type UsageAccumulator,
} from "../usage-accumulator";
import { generateMessageId } from "../message-id";
import { resolveModeConfig } from "./mode-config";
import { makeTitleResultChunk } from "../title-chunk";
import { shouldGenerateTitle } from "../title-merge";
import { createLanguageModel } from "./studio-provider";
import { genTitle } from "../title-generator";
import { extractUserText } from "../extract-user-text";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ChatMessage, HarnessStreamInput, ModelSelection } from "../types";
import type {
  AssembledEngineHandle,
  HarnessAssembledTools,
  RunEngine,
} from "./engine";
import type { DecopilotRunContext } from "./run-context";
import { sanitizeStreamError, stringifyError } from "../stream-error";
import { isDecopilot } from "@decocms/shared/sdk";
import {
  createAgentPrepareStep,
  reconstructEnabledTools,
} from "./agent-loop-state";

// ─────────────────────────────────────────────────────────────────────
// Telemetry hooks
// ─────────────────────────────────────────────────────────────────────

/** Usage shape for the telemetry hooks (mirrors the SDK usage). */
export interface TelemetryUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * The LLM-call telemetry the loop fires at finish/error/abort. The cluster
 * implements these against `@/monitoring/*` (binding `ctx`, `requestId`,
 * `userAgent` in the closure); the desktop leaves them undefined (no sink).
 *
 * The hook args are exactly the non-ctx fields the cluster's
 * `recordLlmCallMetrics` / `monitorLlmCall` need — derived from those call
 * sites so cluster behavior stays byte-identical.
 */
export interface DecopilotTelemetry {
  /** OTel metrics for one LLM call (duration, tokens, cache tokens). */
  recordLlmCall(params: {
    organizationId: string;
    modelId: string;
    durationMs: number;
    isError: boolean;
    errorType?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }): void;
  /** Monitoring log record for one LLM call. */
  monitorLlmCall(params: {
    organizationId: string;
    agentId: string;
    modelId: string;
    modelTitle: string;
    credentialId: string;
    taskId: string;
    durationMs: number;
    isError: boolean;
    finishReason?: string;
    errorMessage?: string;
    usage?: TelemetryUsage;
    totalUsage?: TelemetryUsage;
    cost?: number;
    /** Raw provider request metadata (`result.request`). */
    request?: { body?: unknown };
    /** Provider response metadata + messages (`result.response`). */
    response?: {
      id: string;
      timestamp: Date;
      modelId: string;
      headers?: Record<string, string>;
      messages: unknown[];
      body?: unknown;
    };
    userId: string | null;
  }): void;
}

// ─────────────────────────────────────────────────────────────────────
// Stream args + extras shape
// ─────────────────────────────────────────────────────────────────────

/**
 * Per-request extras that don't live in `HarnessStreamInput` and aren't
 * produced by the env tool runtime. These are read by the streamText loop or
 * by one of its inline callbacks (`prepareStep`, the title/abort/finish
 * paths, or the `toUIMessageStream({ messageMetadata })` decorator).
 */
export interface RunDecopilotStreamExtras {
  /** Provider reconstructed from DecopilotRunContext.modelSources.thinking. */
  provider: StudioProvider;

  /** Provider/model used only for title generation. Lets Decopilot use the org
   *  fast tier even when the main chat model uses another tier/credential. */
  titleProvider?: StudioProvider | null;
  titleModel?: ModelSelection | null;

  /** Run-registry abort signal for this run. Listened to by streamText and
   *  genTitle, and queried from the finish/abort paths to distinguish a real
   *  finish from a user-cancel. Source: `HarnessStreamInput.signal`. */
  registrySignal: AbortSignal;

  /** Per-request inline <system> blocks extracted by `processConversation`. */
  processedSystemMessages: SystemModelMessage[];

  /** The pruned ModelMessage stream streamText consumes as the conversation. */
  processedMessages: Extract<
    ModelMessage,
    { role: "user" | "assistant" | "tool" }
  >[];

  /** The validated UIMessage[] used as `originalMessages` for re-stream dedupe. */
  originalMessages: ChatMessage[];

  /** Thread id — used in spans + metadata. Equals `input.threadId`. */
  threadId: string;

  /** Initial thread title at request entry (title gen only on the default). */
  currentThreadTitle: string;

  /** Screenshot images captured by `take_screenshot`, shared by reference with
   *  the built-in tools and `prepareStep` (mutated in place). */
  pendingImages: import("./built-in-tools/vm-tools/types").PendingImage[];

  /** UIMessageStreamWriter forwarded from the outer createUIMessageStream. */
  writer: UIMessageStreamWriter;

  /** Tool side-channel chunks merged into the main UI message stream. */
  sideChunks?: AsyncIterable<UIMessageChunk>;
  closeSideChunks?: () => void;
  onStepFinish?: StreamTextOnStepFinishCallback<ToolSet>;

  /** LLM-call telemetry hooks (cluster monitoring/metrics; undefined on desktop). */
  telemetry?: DecopilotTelemetry;

  /** Top-level vs delegated subtask run. Gates title generation (Task 16) and,
   *  for `"subtask"`, drives the step-budget override below. */
  kind: "main" | "subtask";

  /** Optional step-budget override forwarded to the engine. The core sets
   *  `SUBAGENT_STEP_LIMIT` for `kind: "subtask"` runs; undefined for main runs
   *  (engine derives `PARENT_STEP_LIMIT`). */
  stepLimit?: number;

  /** Shared cumulative-usage accumulator. The core owns it so a MAIN run's
   *  subtask tool can roll delegated CHILD usage into the SAME accumulator
   *  (`addExternal`) — the parent's final `message-metadata.usage` then
   *  includes child tokens (Task 17 roll-up). Omitted by callers that don't
   *  delegate; defaults to a fresh accumulator. */
  usageAccumulator?: UsageAccumulator;
  runContext?: DecopilotRunContext;
}

export interface RunDecopilotStreamArgs {
  input: HarnessStreamInput;
  tools: HarnessAssembledTools;
  /** Env engine: system-prompt assembly + tool merge + streamText. */
  runEngine: RunEngine;
  extras: RunDecopilotStreamExtras;
}

// ─────────────────────────────────────────────────────────────────────
// Async-queue plumbing
// ─────────────────────────────────────────────────────────────────────

/**
 * Tiny single-producer, single-consumer chunk queue used to merge
 * side-channel chunks (abort-time `message-metadata`) into the main
 * `for await` iteration over `result.toUIMessageStream()`. Closing the queue
 * ends any in-flight wait so the generator can return promptly.
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
 * Run the decopilot streamText loop and yield its UIMessageChunk stream. The
 * generator owns the LLM-call lifetime; on completion (or abort) it tears down
 * the otel span and resolves any background title work before closing.
 *
 * Side-channel chunks are pushed onto an internal queue and interleaved into
 * the main yield loop, matching the inline `writer.write` semantics
 * byte-for-byte.
 */
export async function* runDecopilotStream(
  args: RunDecopilotStreamArgs,
): AsyncGenerator<UIMessageChunk> {
  const { input, tools, runEngine, extras } = args;
  const runContext = extras.runContext;
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
    telemetry,
  } = extras;

  const modeConfig = resolveModeConfig(input.mode, { isCliAgent: false });
  let llmCallStartTime: number | undefined;
  let llmCallLogged = false;

  // Side-channel chunk queue — see `makeChunkQueue` jsdoc for why.
  const chunkQueue = makeChunkQueue();

  // ── Auto-title: generate with this harness's fast model. The cluster
  //    interceptor only persists/broadcasts the generated result.
  //
  //    Gate (D13): only auto-title an unrenamed thread (title still equals the
  //    default), and NEVER for delegated subtask runs. Skipping here saves a
  //    model call the cluster interceptor would otherwise discard post-hoc.
  //    The interceptor keeps its own gate as defense-in-depth against a rename
  //    racing the run.
  const needsTitle = shouldGenerateTitle({
    currentThreadTitle: extras.currentThreadTitle,
    kind: extras.kind,
  });
  // Extract the user-visible text (NOT the JSON-stringified parts array — that
  // would leak `[{"type":"text",...}]` into the fallback title).
  const userMessageText = extractUserText(processedMessages);
  // Ordered fallback chain, fast/cheap first: a per-run title override, then
  // fast → smart → thinking. Lazy factories: models are built only when
  // genTitle actually tries them, and only when a title is needed — so a slot
  // whose provider can't build a model just fails that attempt (rotating to
  // the next / clean fallback) instead of crashing the whole run stream.
  const titleModelChain = ((): Array<() => LanguageModelV3> => {
    if (!needsTitle) return [];
    const seen = new Set<string>();
    const chain: Array<() => LanguageModelV3> = [];
    const push = (
      prov: StudioProvider,
      sel: ModelSelection | null | undefined,
    ) => {
      if (!sel || seen.has(sel.id)) return;
      seen.add(sel.id);
      chain.push(() => createLanguageModel(prov, sel) as never);
    };
    push(titleProvider ?? provider, titleModel);
    push(provider, input.models.fast);
    push(provider, input.models.smart);
    push(provider, input.models.thinking);
    return chain;
  })();
  const titleHandle = needsTitle
    ? genTitle({
        abortSignal: registrySignal,
        models: titleModelChain,
        userMessage: userMessageText,
      })
    : null;
  // When title gen is gated off, this never resolves to a chunk and the title
  // branch of the drain loop is short-circuited (`titleDone` starts true).
  const titlePromise: Promise<UIMessageChunk | null> = titleHandle
    ? titleHandle.promise
        .then((title) => {
          return title ? (makeTitleResultChunk(title) as UIMessageChunk) : null;
        })
        .catch((err) => {
          console.warn(
            "[decopilot:title] title generation failed",
            stringifyError(err),
          );
          return null;
        })
    : Promise.resolve(null);

  // ── Mode + tool gating state shared between prepareStep and the
  //    `tools` argument to streamText ───────────────────────────────
  let reasoningStartAt: Date | null = null;
  // Cumulative usage / cache-token / OpenRouter-cost tracking lives in a
  // shared accumulator used by all harnesses so the emitted
  // `messageMetadata.usage` shape stays identical. The core may supply one
  // (so a MAIN run's subtask tool can fold child usage in via `addExternal`);
  // otherwise we create a fresh one.
  const usageAcc = extras.usageAccumulator ?? createUsageAccumulator();
  llmCallStartTime = Date.now();

  const passthroughToolNames = new Set(Object.keys(tools.passthroughTools));
  const builtInToolNames = Object.keys(tools.builtInTools);
  // `enable_tool` gating is a context-window optimization for the MAIN agent:
  // it starts with connection tools inactive and enables them over the
  // conversation. A SUBAGENT runs a single focused task with EMPTY history, so
  // it would never enable anything — `reconstructEnabledTools` returns ∅ and it
  // sees only the always-on built-ins (the "light toolset" bug). Give a subagent
  // its full toolset up front instead: every passthrough tool active from step 1.
  // `extras.kind === "subtask"` is the reliable signal on the desktop subagent
  // path (it runs through this loop); DecopilotRunContext carries the cluster
  // top-level subagent flag without widening HarnessStreamInput.
  const isDelegatedSubagent =
    extras.kind === "subtask" || runContext?.isSubagent === true;
  const enabledTools = isDelegatedSubagent
    ? new Set(passthroughToolNames)
    : reconstructEnabledTools(originalMessages, passthroughToolNames);

  // Anthropic prompt-cache invariant: the cache key for our system block
  // markers is hash(tools + system_prefix), so the serialized `tools` JSON must
  // be byte-stable across calls that should hit the cache. We rely on
  // object-spread insertion order being deterministic here.
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

  // Non-cached system tail telling the model which tools it already enabled
  // this thread. Lives outside the cached prefix so it can vary per-turn
  // without invalidating Anthropic cache breakpoints.
  const enabledToolsSystemMessage =
    enabledTools.size > 0
      ? {
          role: "system" as const,
          content: `<currently-enabled-tools>\n${[...enabledTools]
            .sort()
            .join("\n")}\n</currently-enabled-tools>`,
        }
      : null;

  // ── Run the env engine ─────────────────────────────────────────────
  // The engine owns system-prompt + tool assembly internally. The loop passes:
  //   - `passthroughClient`  → for the prompts block in the system prompt
  //   - `connectionsData`    → for the connections block in the system prompt
  //   - `extraTools`         → built-ins + enable_tool (state-dependent)
  //   - `prepareStep`        → image injection + plan-mode filter
  //   - `additionalSystemMessages` → per-request inline <system> blocks
  const vmMetadata = runContext?.virtualMcp.metadata as
    | {
        githubRepo?: import("@decocms/shared/sdk").GithubRepo | null;
        subAgents?: string[] | null;
      }
    | undefined;
  const codingWorkspace =
    input.workspace.cwd === "/repo"
      ? {
          repo: input.workspace.repo,
          branch: input.workspace.branch,
          cwd: input.workspace.cwd,
          workspaceKind: "github" as const,
        }
      : undefined;
  const handle: AssembledEngineHandle = await runEngine({
    kind: runContext?.isSubagent ? "subagent" : "agent",
    virtualMcp: {
      id: input.agent.id,
      repo: vmMetadata?.githubRepo ?? undefined,
      delegationTargetIds: vmMetadata?.subAgents,
    },
    mcpClient: tools.passthroughClient,
    provider,
    models: input.models,
    messages: processedMessages,
    abortSignal: registrySignal,
    temperature: input.temperature,
    planMode: modeConfig.isPlanMode,
    isDecopilot: isDecopilot(input.agent.id) !== null,
    codingWorkspace,
    systemAgentInstructions: tools.serverInstructions,
    currentThreadId: threadId,
    user: { id: input.user.id, email: input.user.email },
    userContext: runContext?.userContext,
    writer,
    prepareStep: parentPrepareStep,
    onStepFinish: extras.onStepFinish,
    passthroughClient: tools.passthroughClient,
    connectionsData: {
      tools: tools.connectionsBlockTools,
      connectionTitleMap: tools.connectionTitleMap,
    },
    // Pass the full parent built-ins (heavy tools: VM, web_search, screenshot,
    // etc.) as extraTools so the engine's lightweight assembled set is
    // overridden with the complete set. Also inject enable_tool, which is
    // state-dependent (built from enabledTools reconstructed above).
    // The engine re-assembles the MCP tools; bind them to the run's map so
    // their truncated outputs land where `read_tool_output` looks.
    toolOutputMap: tools.toolOutputMap,
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
    activeToolNames: [
      ...builtInToolNames,
      ...("enable_tool" in streamTools ? ["enable_tool"] : []),
      ...enabledTools,
    ],
    // Subtask runs cap the engine at SUBAGENT_STEP_LIMIT (Task 17); main runs
    // use the per-automation `maxAgentSteps` override when set, else leave it
    // undefined so the engine derives PARENT_STEP_LIMIT.
    stepLimit: extras.stepLimit ?? input.maxAgentSteps,
  });

  const result = handle.result;

  // ── The loop's own metrics/monitoring around the result.
  const finishMetricsPromise = Promise.resolve(result.finishReason)
    .then(async (finishReason) => {
      const [totalUsage, usage, request, response] = await Promise.all([
        result.totalUsage,
        result.usage,
        result.request,
        result.response,
      ]);
      // If there was an error, the onError path below handles metrics. Guard
      // with the error handle to avoid double-logging.
      const capturedErr = await handle.error;
      if (capturedErr !== undefined) return;

      // OTel attrs on the engine span (handle.span)
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
      telemetry?.recordLlmCall({
        organizationId: input.organizationId,
        modelId: input.models.thinking.id,
        durationMs,
        isError: false,
        inputTokens: totalUsage.inputTokens,
        outputTokens: totalUsage.outputTokens,
        cacheReadTokens: cacheTotals.read,
        cacheWriteTokens: cacheTotals.write,
      });
      telemetry?.monitorLlmCall({
        organizationId: input.organizationId,
        agentId: input.agent.id,
        modelId: input.models.thinking.id,
        modelTitle: input.models.thinking.title ?? input.models.thinking.id,
        credentialId: input.models.thinking.credentialId,
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
      });

      if (registrySignal.aborted) return;
    })
    .catch(async (error) => {
      // error path — finishReason promise itself rejected OR we got here from a
      // provider error. The engine's onError fires first and sets handle.error;
      // we pick up the message from there.
      const rawError =
        error instanceof Error ? error : new Error(stringifyError(error));
      console.error("[decopilot:stream] Error", rawError.message);
      if (registrySignal.aborted) {
        return;
      }
      if (!llmCallLogged) {
        const durationMs = Date.now() - (llmCallStartTime ?? Date.now());
        llmCallLogged = true;
        telemetry?.recordLlmCall({
          organizationId: input.organizationId,
          modelId: input.models.thinking.id,
          durationMs,
          isError: true,
          errorType: rawError.name,
        });
        telemetry?.monitorLlmCall({
          organizationId: input.organizationId,
          agentId: input.agent.id,
          modelId: input.models.thinking.id,
          modelTitle: input.models.thinking.title ?? input.models.thinking.id,
          credentialId: input.models.thinking.credentialId,
          taskId: threadId,
          durationMs,
          isError: true,
          errorMessage: rawError.message,
          userId: input.user.id,
        });
      }
    });
  const finishMetricsDonePromise = finishMetricsPromise.catch((err) => {
    console.error("[decopilot:stream] finish metrics failed", err);
  });

  // onAbort path: the old code's onAbort fires when steps.length > 0 and
  // llmCallLogged is false. We re-implement by watching handle.error AND
  // registrySignal.aborted. Register before draining the stream. Resolves to an
  // optional metadata chunk merged alongside title + side-channel chunks so
  // abort usage isn't lost after the main stream closes.
  const abortMetadataPromise = handle.error.then(async (_errMsg) => {
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
    telemetry?.recordLlmCall({
      organizationId: input.organizationId,
      modelId: input.models.thinking.id,
      durationMs,
      isError: false,
      inputTokens: abortTotalUsage.inputTokens,
      outputTokens: abortTotalUsage.outputTokens,
      cacheReadTokens: cacheTotalsOnAbort.read,
      cacheWriteTokens: cacheTotalsOnAbort.write,
    });
    telemetry?.monitorLlmCall({
      organizationId: input.organizationId,
      agentId: input.agent.id,
      modelId: input.models.thinking.id,
      modelTitle: input.models.thinking.title ?? input.models.thinking.id,
      credentialId: input.models.thinking.credentialId,
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
    });

    // Re-push accumulated usage to the client. On abort the SDK resets
    // message.metadata to its pre-stream state, so we explicitly emit it here
    // before the stream closes.
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

  // ── UIMessage stream + side-channel queue, drained concurrently ──
  const uiMessageStream = result.toUIMessageStream({
    originalMessages: originalMessages as never,
    generateMessageId,
    onError: (error) => sanitizeStreamError(error),
    messageMetadata: ({ part }) => {
      if (part.type === "start") {
        return {
          agent: {
            id: input.agent.id ?? null,
          },
          models: {
            credentialId: input.models.thinking.credentialId,
            thinking: {
              ...input.models.thinking,
              title: input.models.thinking.title ?? input.models.thinking.id,
              provider: input.models.thinking.provider ?? undefined,
            },
          },
          created_at: new Date(),
          _request: {
            // Derived from the REAL prompt the engine assembled — the single
            // surviving assembler (the old duplicate cluster prompt path that
            // existed only for this debug metadata is deleted).
            systemSections: handle.assembledSystemMessages.map((p) => ({
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
          // Set for a backgrounded subtask run: correlates this message to the
          // originating `subtask` tool call (== its `jobId`) so the UI nests it
          // inside that card instead of rendering it top-level.
          ...(runContext?.subtaskJobId
            ? { subtaskJobId: runContext.subtaskJobId }
            : {}),
          // Set when this turn resumes the agent after a backgrounded tool
          // completed — the UI shows a "resumed" indicator on the message.
          ...(runContext?.resumedFromBackground
            ? { resumedFromBackground: true }
            : {}),
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
        usageAcc.addStep(part.usage, part.providerMetadata);
        return { usage: usageAcc.buildStepUsage() };
      }

      if (part.type === "finish") {
        const usage = usageAcc.buildFinalUsage({
          totalUsage: part.totalUsage,
          providerKey: input.models.thinking.provider,
          fallbackProviderMetadata: (
            part as { providerMetadata?: Record<string, unknown> }
          ).providerMetadata,
        });
        return usage ? { usage } : {};
      }

      return;
    },
  });

  // Drain the uiMessageStream and side-channel queues concurrently. Both
  // `mainPromise` and `queuePromise` are held across loop iterations — re-armed
  // only after the corresponding source produces a value — so we never lose
  // chunks.
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
  // When title gen is gated off (`titleHandle === null`), there is nothing to
  // wait for — start the title branch already settled so the drain loop never
  // pushes `titleResultPromise` and never tries to `finish()` a null handle.
  let titleDone = titleHandle === null;
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
        // queue/side promises until both report done.
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
            titleHandle?.finish();
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
    // Defensive: make sure the queue is closed so any callback fired after we
    // exit can't hang the consumer.
    if (!titleDone) titleHandle?.finish();
    extras.closeSideChunks?.();
    await iter.return?.().catch(() => {});
    await sideIter?.return?.().catch(() => {});
    chunkQueue.close();
  }

  // Posthog `chat_message_*` events are emitted from the outer
  // createUIMessageStream onFinish/onError (they need the final
  // responseMessage). They stay in the caller.
}

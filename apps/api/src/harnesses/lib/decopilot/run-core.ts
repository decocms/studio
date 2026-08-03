/**
 * runDecopilotCore — the shared Decopilot orchestration loop.
 *
 * Extracted from the hosted `decopilot/index.ts` factory body so orchestration
 * stays independent of cluster wiring. The core owns:
 *   - the model-runtime bundle shape (`ModelRuntime`),
 *   - the deps seam (`RunDecopilotCoreDeps`) every environment satisfies,
 *   - `processConversation` invocation against the assembled tool set,
 *   - delegation to `runDecopilotStream` for the streamText + title +
 *     side-channel merge loop (which itself drives the env engine via
 *     `toolRuntime.runEngine`).
 *
 * Environment-specific pieces are injected through the deps:
 *   - `modelRuntime` — adapter-constructed provider/model bundle (never wired);
 *   - `toolRuntime` — the virtual-MCP passthrough, hosted built-ins, and
 *     `runAgentLoop` streamText engine;
 *   - `telemetry` — hosted LLM-call monitoring and metrics hooks.
 *
 * The single surviving prompt assembler is the ENGINE's (`runAgentLoop` →
 * `buildAgentSystemPrompt`): its assembled system messages feed both the model
 * AND the `_request.systemSections` debug metadata. The old duplicate cluster
 * `assembleDecopilotPrompt` path that existed only for that debug metadata is
 * deleted.
 *
 * This module is `@/*`-free so the hosted core can be exercised independently;
 * cluster-specific closures are supplied by `decopilot/index.ts`.
 */

import type { UIMessageChunk } from "ai";
import type {
  DecopilotSecretModelSources,
  DecopilotSecretModelSource,
  HarnessStreamInput,
  ModelSelection,
} from "../types";
import type { StudioProvider } from "./studio-provider";
import type {
  AssembledEngineHandle,
  HarnessAssembledTools,
  RunEngineArgs,
} from "./engine";
import {
  runDecopilotStream,
  type DecopilotTelemetry,
  type RunDecopilotStreamExtras,
} from "./run-stream";
import { processConversation } from "./conversation";
import { DEFAULT_WINDOW_SIZE, SUBAGENT_STEP_LIMIT } from "./prompt-constants";
import { createUsageAccumulator } from "../usage-accumulator";
import { createSemaphore } from "../semaphore";
import { getDecopilotRunContext, setDecopilotRunContext } from "./run-context";

export type { DecopilotTelemetry } from "./run-stream";

// ─────────────────────────────────────────────────────────────────────
// Model runtime
// ─────────────────────────────────────────────────────────────────────

/** One resolved (model, provider) pair for a Decopilot model slot. */
export interface ModelRuntimeSlot {
  model: ModelSelection;
  provider: StudioProvider;
}

/**
 * Adapter-constructed bundle of every resolved model slot. `thinking` is
 * required; the rest are present only when the request configured them.
 * Never serialized — the wire carries `models` + `modelSources`, and each
 * adapter rebuilds this bundle locally (spec "Model Runtime").
 */
export interface ModelRuntime {
  thinking: ModelRuntimeSlot;
  fast?: ModelRuntimeSlot;
  smart?: ModelRuntimeSlot;
  image?: ModelRuntimeSlot;
  webSearch?: ModelRuntimeSlot;
  deepResearch?: ModelRuntimeSlot;
}

/**
 * Minimal source view `buildModelRuntimeFromSources` reads: the per-slot wire
 * `models` (so each slot knows its model id/capabilities) and the resolved
 * `modelSources` the adapter turns into providers. Mirrors the relevant fields
 * of `HarnessStreamInput`.
 */
export interface ModelRuntimeSources {
  models: HarnessStreamInput["models"];
  modelSources?: DecopilotSecretModelSources;
}

/**
 * Build the `ModelRuntime` bundle from the resolved wire sources. `createProvider`
 * is the environment's secret→provider factory (`createProviderFromSecret` on
 * both sides today). `thinking` is required and throws when its source is
 * missing or non-secret; optional slots are populated only when the request
 * both selected the slot (`models.<slot>`) and resolved a secret source for it,
 * falling back to the thinking provider otherwise (decision D12 — image/
 * deep-research/title ride the thinking credential when not separately pinned).
 */
export function buildModelRuntimeFromSources(
  sources: ModelRuntimeSources,
  createProvider: (source: DecopilotSecretModelSource) => StudioProvider,
): ModelRuntime {
  const thinkingSource = sources.modelSources?.thinking ?? null;
  if (!thinkingSource || thinkingSource.kind !== "secret") {
    throw new Error(
      "Decopilot core requires a secret thinking model source. Dispatch " +
        "must resolve the selected model credential before invoking Decopilot.",
    );
  }
  const thinkingProvider = createProvider(thinkingSource);

  const optionalSlot = (
    slot: "fast" | "smart" | "image" | "webSearch" | "deepResearch",
  ): ModelRuntimeSlot | undefined => {
    const model = sources.models[slot];
    if (!model) return undefined;
    const source = sources.modelSources?.[slot];
    if (source && source.kind !== "secret") {
      throw new Error(
        "Decopilot core requires secret modelSources for all resolved slots.",
      );
    }
    return {
      model,
      provider:
        source && source.kind === "secret"
          ? createProvider(source)
          : thinkingProvider,
    };
  };

  const fast = optionalSlot("fast");
  const smart = optionalSlot("smart");
  const image = optionalSlot("image");
  const webSearch = optionalSlot("webSearch");
  const deepResearch = optionalSlot("deepResearch");
  return {
    thinking: { model: sources.models.thinking, provider: thinkingProvider },
    ...(fast ? { fast } : {}),
    ...(smart ? { smart } : {}),
    ...(image ? { image } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(deepResearch ? { deepResearch } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Deps seam
// ─────────────────────────────────────────────────────────────────────

/**
 * The tool + engine runtime. `buildEnvironmentTools` opens the env's MCP
 * passthrough client and assembles its full tool set (plus the per-run
 * side-channel/writer/pending-images/step-finish wiring it owns); `runEngine`
 * drives the env's system-prompt assembly + tool merge + streamText loop. The
 * hosted adapter implements both via `assembleDecopilotTools` + `runAgentLoop`.
 */
export interface DecopilotToolRuntime {
  /** Assemble the environment-specific tool bundle for one turn.
   *  `onChildUsage` (when present) is the parent run's usage roll-up sink: the
   *  adapter wires it into the `subtask` tool so each delegated child run's
   *  usage folds into the parent's accumulator (Task 17). Absent on
   *  `kind: "subtask"` runs (which expose no subtask tool — depth-1). */
  buildEnvironmentTools(args: {
    input: HarnessStreamInput;
    onChildUsage?: (usage: SubtaskRunResult["usage"]) => void;
  }): Promise<HarnessAssembledTools>;
  /** Run the system-prompt + tool-assembly + streamText engine. The cluster
   *  closure captures `ctx` + `organization`; only the portable args flow in. */
  runEngine(args: RunEngineArgs): Promise<AssembledEngineHandle>;
}

export interface RunDecopilotCoreDeps {
  input: HarnessStreamInput;
  modelRuntime: ModelRuntime;
  toolRuntime: DecopilotToolRuntime;
  telemetry?: DecopilotTelemetry;
  /** Discriminates a top-level run from a delegated subtask run. Title
   *  generation is gated on `"main"` (Task 16). A `"subtask"` run additionally
   *  strips the `subtask` tool (depth-1) and caps the engine at
   *  `SUBAGENT_STEP_LIMIT` (Task 17); `spawnSubtask` forces this value. Cluster
   *  top-level streams pass `"main"`. */
  kind: "main" | "subtask";
}

// ─────────────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────────────

/**
 * Run one Decopilot turn end-to-end and yield its `UIMessageChunk` stream.
 *
 * 1. `toolRuntime.buildEnvironmentTools` opens the MCP passthrough client and
 *    assembles the env tool set + per-run streaming wiring (its lifecycle —
 *    including `.close()` — is owned by the caller/adapter, which sets up the
 *    try/finally around this generator).
 * 2. `processConversation` runs against the REAL tool set so prior-turn tool
 *    outputs transform via each tool's `toModelOutput`.
 * 3. `runDecopilotStream` drives the streamText loop: it builds the
 *    enable_tool/prepareStep state, calls `toolRuntime.runEngine` for the
 *    system-prompt + tool-assembly + streamText engine, fires `telemetry`
 *    hooks, generates the title, and merges the side channel. The engine's
 *    assembled system messages feed the `_request.systemSections` debug
 *    metadata.
 *
 * Behavior is byte-identical to the pre-extraction cluster factory body.
 */
export async function* runDecopilotCore(
  deps: RunDecopilotCoreDeps,
): AsyncIterable<UIMessageChunk> {
  const { input, modelRuntime, toolRuntime, telemetry } = deps;
  const runContext = getDecopilotRunContext(input);
  const isSubtask = deps.kind === "subtask";

  // The core owns the cumulative-usage accumulator so a MAIN run's `subtask`
  // tool can roll delegated CHILD usage into the SAME accumulator — the
  // parent's final `message-metadata.usage` then includes child tokens
  // (Task 17 roll-up). Subtask runs delegate nothing (depth-1), so they don't
  // need the sink.
  const usageAccumulator = createUsageAccumulator();
  const onChildUsage = isSubtask
    ? undefined
    : (usage: SubtaskRunResult["usage"]) => usageAccumulator.addExternal(usage);

  const tools = await toolRuntime.buildEnvironmentTools({
    input,
    onChildUsage,
  });

  // Depth-1: a `subtask` core run must NOT expose the `subtask` tool, so a
  // delegated run can't spawn its own delegated runs. Strip it from the
  // tool-host surfaces the engine reads (`tools` + `builtInTools`; the cluster
  // also excludes it for `kind: "subagent"` in assemble-agent-tools, but the
  // core enforces it so every adapter inherits depth-1).
  if (isSubtask) stripSubtaskTool(tools);

  const {
    systemMessages: processedSystemMessages,
    messages: processedMessages,
    originalMessages,
  } = await processConversation(runContext?.messages ?? [input.userMessage], {
    windowSize: DEFAULT_WINDOW_SIZE,
    models: input.models,
    tools: tools.tools,
  });

  // processConversation splits system messages out internally, so `messages`
  // only ever holds user/assistant/tool. Narrow at the boundary.
  const narrowedMessages =
    processedMessages as RunDecopilotStreamExtras["processedMessages"];

  const titleSlot =
    input.models.fast ?? input.models.smart ?? input.models.thinking;
  const titleProvider =
    (input.models.fast ? modelRuntime.fast?.provider : undefined) ??
    (input.models.smart ? modelRuntime.smart?.provider : undefined) ??
    modelRuntime.thinking.provider;

  yield* runDecopilotStream({
    input,
    tools,
    runEngine: toolRuntime.runEngine,
    extras: {
      provider: modelRuntime.thinking.provider,
      titleProvider,
      titleModel: titleSlot,
      registrySignal: input.signal ?? new AbortController().signal,
      processedSystemMessages,
      processedMessages: narrowedMessages,
      originalMessages:
        originalMessages as RunDecopilotStreamExtras["originalMessages"],
      threadId: input.threadId,
      currentThreadTitle: input.currentThreadTitle ?? "",
      pendingImages: tools.pendingImages,
      writer: tools.writer,
      sideChunks: tools.sideChunks,
      closeSideChunks: tools.closeSideChunks,
      onStepFinish: tools.onStepFinish,
      telemetry,
      kind: deps.kind,
      // Subtask runs cap the engine at SUBAGENT_STEP_LIMIT (Task 17).
      stepLimit: isSubtask ? SUBAGENT_STEP_LIMIT : undefined,
      // Shared so the subtask tool's child-usage roll-up lands in the same
      // accumulator that builds the final `message-metadata.usage`.
      usageAccumulator,
      runContext,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Subtask spawning (Task 17)
// ─────────────────────────────────────────────────────────────────────

/** Small process-wide cap on concurrent `subtask` core runs (decision Q17).
 *  A counting semaphore (below) bounds delegated runs so a fan-out of parallel
 *  subtasks can't exhaust model/CPU budget. */
export const SUBTASK_MAX_CONCURRENT = 4;

/** Module-scoped semaphore: concurrency is bounded across ALL subtasks in the
 *  process, not per-parent-run. Acquired (abortably) before a subtask core run
 *  starts and released in `finally`. */
const subtaskSemaphore = createSemaphore(SUBTASK_MAX_CONCURRENT);

/** The summarized outcome of one delegated subtask run. `text` is the
 *  aggregated assistant text; `usage` is the child run's token totals (rolled
 *  into the parent via `addExternal`). */
export interface SubtaskRunResult {
  text: string;
  error?: string;
  finishReason?: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface SpawnSubtaskArgs {
  /** The self-contained task prompt for the fresh subagent. */
  prompt: string;
  /** Target-agent core deps the hosted adapter builds with an in-process
   *  passthrough client. `kind` is forced to `"subtask"` here, so the caller
   *  need not set it. */
  deps: Omit<RunDecopilotCoreDeps, "kind">;
  /** The PARENT tool-call abort signal, chained into the subtask core run so
   *  parent cancellation kills the subtask (and aborts a queued
   *  semaphore wait). */
  signal: AbortSignal;
}

/**
 * Run one delegated subtask end-to-end and summarize it.
 *
 * Portable (`@/*`-free) so hosted subtask paths reuse it; target-specific deps
 * construction stays in the adapter. Enforces the hosted resource policy:
 *   - concurrency: a module-scoped semaphore caps process-wide parallelism
 *     (`SUBTASK_MAX_CONCURRENT`); a queued wait is abortable via `signal`;
 *   - depth-1 + step budget: `runDecopilotCore({ kind: "subtask" })` strips the
 *     subtask tool and caps the engine at `SUBAGENT_STEP_LIMIT`;
 *   - signal chaining: `signal` is fed into the core run as `input.signal` so
 *     parent cancellation propagates.
 *
 * Drains the child's `UIMessageChunk` stream, collecting assistant text from
 * `text-delta` chunks and usage/finishReason from the final `finish` chunk's
 * `messageMetadata`. Never throws for a child-run failure — it returns the
 * error on the result so the caller's `toModelOutput` renders it.
 */
export async function spawnSubtask(
  args: SpawnSubtaskArgs,
): Promise<SubtaskRunResult> {
  await subtaskSemaphore.acquire(args.signal);
  try {
    return await runSubtaskCore(args);
  } finally {
    subtaskSemaphore.release();
  }
}

async function runSubtaskCore(
  args: SpawnSubtaskArgs,
): Promise<SubtaskRunResult> {
  const { prompt, deps, signal } = args;
  const text: string[] = [];
  let error: string | undefined;
  // `finishReason` is best-effort from the UI chunk stream — the AI SDK keeps
  // it on `StreamTextResult`, not on `UIMessageChunk`. It's populated when a
  // chunk surfaces it (some `finish`/`finish-step` shapes do); otherwise it
  // stays undefined and the caller's `toModelOutput` treats it as a normal
  // finish. Usage + text are the load-bearing fields.
  let finishReason: string | undefined;
  let usage: SubtaskRunResult["usage"] = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  // Chain the parent tool-call signal into the child core run.
  const subtaskInput: HarnessStreamInput = {
    ...deps.input,
    userMessage: {
      id: "subtask-prompt",
      role: "user",
      parts: [{ type: "text", text: prompt }],
    },
    signal,
  };
  const runContext = getDecopilotRunContext(deps.input);
  if (runContext) {
    setDecopilotRunContext(subtaskInput, {
      ...runContext,
      messages: [subtaskInput.userMessage],
    });
  }

  try {
    for await (const chunk of runDecopilotCore({
      ...deps,
      input: subtaskInput,
      kind: "subtask",
    })) {
      const c = chunk as {
        type: string;
        delta?: string;
        finishReason?: string;
        messageMetadata?: {
          usage?: {
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
          };
        };
      };
      if (c.type === "text-delta" && typeof c.delta === "string") {
        text.push(c.delta);
      } else if (c.type === "finish") {
        if (typeof c.finishReason === "string") finishReason = c.finishReason;
        const u = c.messageMetadata?.usage;
        // The final `finish` chunk carries the cumulative total. Take whichever
        // chunk supplies usage (prefer a later, larger total).
        if (u) {
          usage = {
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            totalTokens: u.totalTokens ?? 0,
          };
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    text: text.join("").trim(),
    error,
    finishReason,
    usage,
  };
}

/** Strip the `subtask` tool from the tool-host surfaces the engine reads
 *  (`tools` + `builtInTools`), enforcing depth-1 for delegated runs.
 *  `passthroughTools` is never a subtask host, so it isn't touched. Mutates
 *  the bundle in place. */
function stripSubtaskTool(tools: HarnessAssembledTools): void {
  if ("subtask" in tools.tools) {
    const { subtask: _s, ...rest } = tools.tools as Record<string, unknown>;
    tools.tools = rest as typeof tools.tools;
  }
  if ("subtask" in tools.builtInTools) {
    const { subtask: _s, ...rest } = tools.builtInTools as Record<
      string,
      unknown
    >;
    tools.builtInTools = rest as typeof tools.builtInTools;
  }
}

/**
 * runDecopilotCore — the shared Decopilot orchestration loop.
 *
 * Extracted from the cluster `decopilot/index.ts` factory body so the cluster
 * AND (Task 15) the desktop daemon drive ONE loop. The core owns:
 *   - the model-runtime bundle shape (`ModelRuntime`),
 *   - the deps seam (`RunDecopilotCoreDeps`) every environment satisfies,
 *   - `processConversation` invocation against the assembled tool set,
 *   - delegation to `runDecopilotStream` for the streamText + title +
 *     side-channel merge loop (which itself drives the env engine via
 *     `toolRuntime.runEngine`).
 *
 * Environment-specific pieces are injected through the deps:
 *   - `modelRuntime` — adapter-constructed provider/model bundle (never wired);
 *   - `toolRuntime` — `buildEnvironmentTools()` (cluster: virtual-MCP
 *     passthrough + web_search/update_interests/Browserless built-ins; desktop:
 *     HTTP passthrough + local built-ins) and `runEngine()` (the system-prompt +
 *     tool-assembly + streamText engine — `runAgentLoop` on the cluster,
 *     `runNativeAgentLoopCore` on the desktop);
 *   - `telemetry` — the cluster LLM-call monitoring/metrics hooks (no-op on the
 *     desktop).
 *
 * The single surviving prompt assembler is the ENGINE's (`runAgentLoop` →
 * `buildAgentSystemPrompt`): its assembled system messages feed both the model
 * AND the `_request.systemSections` debug metadata. The old duplicate cluster
 * `assembleDecopilotPrompt` path that existed only for that debug metadata is
 * deleted.
 *
 * This module is `@/*`-free so the daemon can bundle it. The cluster supplies
 * ctx-backed closures from `decopilot/index.ts`; the desktop (Task 15) supplies
 * HTTP/local ones.
 */

import type { UIMessageChunk } from "ai";
import type {
  DecopilotSecretModelSource,
  HarnessStreamInput,
  ModelSelection,
} from "../types";
import type { MeshProvider } from "./mesh-provider";
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
import { DEFAULT_WINDOW_SIZE } from "./prompt-constants";

export type { DecopilotTelemetry } from "./run-stream";

// ─────────────────────────────────────────────────────────────────────
// Model runtime
// ─────────────────────────────────────────────────────────────────────

/** One resolved (model, provider) pair for a Decopilot model slot. */
export interface ModelRuntimeSlot {
  model: ModelSelection;
  provider: MeshProvider;
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
  modelSources: HarnessStreamInput["modelSources"];
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
  createProvider: (source: DecopilotSecretModelSource) => MeshProvider,
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
    slot: "fast" | "smart" | "image" | "deepResearch",
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
  const deepResearch = optionalSlot("deepResearch");
  return {
    thinking: { model: sources.models.thinking, provider: thinkingProvider },
    ...(fast ? { fast } : {}),
    ...(smart ? { smart } : {}),
    ...(image ? { image } : {}),
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
 * cluster implements both via `assembleDecopilotTools` + `runAgentLoop`; the
 * desktop (Task 15) via `buildLocalTools` + `runNativeAgentLoopCore`.
 */
export interface DecopilotToolRuntime {
  /** Assemble the environment-specific tool bundle for one turn. */
  buildEnvironmentTools(args: {
    input: HarnessStreamInput;
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
   *  generation is gated on `"main"` (Task 16); `"subtask"` wiring is Task 17.
   *  For now every cluster call passes `"main"`. */
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

  const tools = await toolRuntime.buildEnvironmentTools({ input });

  const {
    systemMessages: processedSystemMessages,
    messages: processedMessages,
    originalMessages,
  } = await processConversation(input.messages, {
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
    },
  });
}

/**
 * Decopilot harness — the CLUSTER adapter for the shared Decopilot core.
 *
 * The orchestration (processConversation → engine → streamText → title +
 * side-channel merge) lives in `runDecopilotCore` (`./run-core`). This factory
 * is the CLUSTER ADAPTER: it builds the cluster-specific dependencies the core
 * needs and hands them off, keeping cluster behavior byte-identical.
 *
 * Cluster adapter responsibilities:
 *   - `modelRuntime`  — providers reconstructed from the resolved secret model
 *     sources (`buildModelRuntimeFromSources` + `createProviderFromSecret`).
 *   - `toolRuntime.buildEnvironmentTools` — opens the in-process MCP passthrough
 *     client + assembles the full cluster tool set (`assembleDecopilotTools`:
 *     web_search / update_interests / Browserless built-ins) and owns the
 *     per-run side-channel writer + html-page buffer lifecycle.
 *   - `toolRuntime.runEngine` — closes over `ctx` + `organization` and delegates
 *     to `runAgentLoop` (system-prompt + tool assembly + streamText).
 *   - `telemetry` — cluster LLM-call monitoring + metrics
 *     (`@/monitoring/emit-llm-call`, `record-llm-call-metrics`).
 *
 * Created per-call (one `Harness` instance per stream) because the underlying
 * loop is stateful. The factory captures `ctx` so `HarnessStreamInput` stays
 * serializable for the remote transport.
 *
 * The desktop daemon has its own import-isolated `decopilotDesktopHarnessFactory`
 * (`harnesses/decopilot-desktop/`); it never calls THIS cluster factory, so
 * there's no desktop branch here. Task 15 points the desktop factory at the
 * same `runDecopilotCore` with HTTP/local adapter deps and deletes its
 * duplicate loop.
 */

import type { UIMessageChunk } from "ai";
import type { HarnessContext } from "../../core/harness-context";
import type {
  StudioContext,
  OrganizationScope,
} from "../../core/studio-context";
import type { Harness, HarnessFactory, HarnessStreamInput } from "../types";
import { monitorLlmCall } from "@/monitoring/emit-llm-call";
import { recordLlmCallMetrics } from "@/monitoring/record-llm-call-metrics";
import { assembleDecopilotTools } from "./tools";
import { createHtmlPageBuffer } from "./built-in-tools/vm-tools/html-page-buffer";
import { createProviderFromSecret } from "./provider-from-secret";
import { createSideChannelWriter } from "../side-channel-writer";
import {
  buildModelRuntimeFromSources,
  runDecopilotCore,
  type DecopilotToolRuntime,
} from "./run-core";
import type { DecopilotTelemetry } from "./run-stream";
import type {
  AssembledEngineHandle,
  HarnessAssembledTools,
  RunEngineArgs,
} from "./engine";
import { runAgentLoop } from "./run-agent-loop";
import type { PendingImage } from "./built-in-tools";

/**
 * Cluster engine adapter: maps the portable `RunEngineArgs` onto the ctx-coupled
 * `runAgentLoop` (which owns system-prompt assembly + tool assembly + the
 * native streamText loop). Closes over `ctx` + `organization`. No behavior
 * change — this is the same `runAgentLoop` call the factory made before the
 * extraction, with the parent-supplied args threaded through.
 */
async function runClusterEngine(
  ctx: StudioContext,
  organization: OrganizationScope,
  args: RunEngineArgs,
): Promise<AssembledEngineHandle> {
  const handle = await runAgentLoop({
    kind: args.kind,
    ctx,
    organization,
    virtualMcp: args.virtualMcp,
    mcpClient: args.mcpClient,
    provider: args.provider,
    models: args.models,
    messages: args.messages,
    abortSignal: args.abortSignal,
    temperature: args.temperature,
    planMode: args.planMode,
    isDecopilot: args.isDecopilot,
    systemAgentInstructions: args.systemAgentInstructions,
    currentThreadId: args.currentThreadId,
    writer: args.writer,
    subtaskParams: {
      provider: args.provider,
      organization,
      models: args.models,
    },
    prepareStep: args.prepareStep,
    onStepFinish: args.onStepFinish,
    passthroughClient: args.passthroughClient,
    connectionsData: args.connectionsData,
    extraTools: args.extraTools,
    additionalSystemMessages: args.additionalSystemMessages,
    // Subtask core runs cap the loop at SUBAGENT_STEP_LIMIT (Task 17).
    stepLimit: args.stepLimit,
  });
  return {
    result: handle.result,
    error: handle.error,
    span: handle.span,
    assembledSystemMessages: handle.assembledSystemMessages,
  };
}

export const decopilotHarnessFactory: HarnessFactory = {
  id: "decopilot",
  create(harnessCtx: HarnessContext): Harness {
    // `storage` and `db` are required fields on StudioContext but absent from
    // HarnessContext. The cluster always constructs this factory with a full
    // StudioContext; the desktop uses its own import-isolated factory.
    const ctx = harnessCtx as StudioContext;
    return {
      id: "decopilot",
      async *stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
        const organization = ctx.organization!;

        // ── Model runtime: providers from resolved secret sources. ────────
        const modelRuntime = buildModelRuntimeFromSources(
          { models: input.models, modelSources: input.modelSources },
          createProviderFromSecret,
        );

        // ── Per-run side-channel + html-page buffer (cluster lifecycle). ──
        const sideChannel = createSideChannelWriter();
        const htmlPageBuffer = createHtmlPageBuffer(ctx, sideChannel.writer);

        // ── Cluster tool runtime. ─────────────────────────────────────────
        // The assembled tool bundle owns a live passthrough MCP client; the
        // factory must close it on completion/abort. Capture the cleanup here
        // (assigned inside `buildEnvironmentTools`) so the finally below runs
        // it even if the core throws mid-stream.
        const cleanup: { close?: () => Promise<void> } = {};
        const toolRuntime: DecopilotToolRuntime = {
          buildEnvironmentTools: async ({
            input: streamInput,
            onChildUsage,
          }) => {
            const toolOutputMap = new Map<string, string>();
            const pendingImages: PendingImage[] = [];
            const assembled = await assembleDecopilotTools(streamInput, ctx, {
              writer: sideChannel.writer,
              toolOutputMap,
              pendingImages,
              threadId: streamInput.threadId,
              provider: modelRuntime.thinking.provider,
              imageProvider:
                modelRuntime.image?.provider ?? modelRuntime.thinking.provider,
              deepResearchProvider:
                modelRuntime.deepResearch?.provider ??
                modelRuntime.thinking.provider,
              htmlPageBuffer,
              // Roll subtask child usage into the parent run's accumulator
              // (Task 17). Threaded into the subtask tool via getBuiltInTools.
              onChildUsage,
            });
            const bundle: HarnessAssembledTools = {
              tools: assembled.tools,
              passthroughTools: assembled.passthroughTools,
              builtInTools: assembled.builtInTools,
              connectionsBlockTools: assembled.connectionsBlockTools,
              toolAnnotations: assembled.toolAnnotations,
              connectionTitleMap: assembled.connectionTitleMap,
              serverInstructions: assembled.serverInstructions,
              passthroughClient: assembled.passthroughClient,
              writer: sideChannel.writer,
              pendingImages,
              sideChunks: sideChannel.stream,
              closeSideChunks: sideChannel.close,
              onStepFinish: async () => {
                await htmlPageBuffer.flush().catch((err) => {
                  console.error("[decopilot] html-page flush failed", err);
                });
              },
              close: assembled.close,
            };
            cleanup.close = assembled.close;
            return bundle;
          },
          runEngine: (args) => runClusterEngine(ctx, organization, args),
        };

        // ── Cluster telemetry (monitoring + metrics). ─────────────────────
        const telemetry: DecopilotTelemetry = {
          recordLlmCall: (params) => recordLlmCallMetrics({ ctx, ...params }),
          monitorLlmCall: (params) =>
            monitorLlmCall({
              ctx,
              ...params,
              requestId: ctx.metadata.requestId,
              userAgent: ctx.metadata.userAgent ?? null,
            }),
        };

        try {
          yield* runDecopilotCore({
            input,
            modelRuntime,
            toolRuntime,
            telemetry,
            kind: "main",
          });
        } finally {
          sideChannel.close();
          await cleanup.close?.().catch(() => {});
        }
      },
    };
  },
};

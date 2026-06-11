/**
 * CLUSTER Decopilot environment-deps assembler (spec §5.2/§9 — "ONE factory").
 *
 * The Decopilot harness runs ONE orchestration loop (`runDecopilotCore`); the
 * only difference between the cluster and the desktop daemon is which
 * `DecopilotToolRuntime` + `telemetry` the environment builds. The single
 * `decopilotHarnessFactory` (`./index.ts`) selects between this StudioContext-
 * backed assembler and the desktop one by inspecting the injected context shape:
 *
 *   - `buildClusterEnvironmentTools` (here) — the StudioContext-backed branch:
 *     the in-process virtual-MCP passthrough client + the full cluster tool set
 *     (web_search / update_interests / Browserless built-ins) + the per-run
 *     html-page buffer, plus the ctx-coupled `runAgentLoop` engine + telemetry.
 *   - `buildDesktopEnvironmentTools` (`./desktop-runtime.ts`) — the import-
 *     isolated daemon branch: an HTTP MCP passthrough client + the local-OK
 *     built-ins + the portable `runNativeAgentLoopCore` engine with a
 *     cluster-storage-free system prompt. It lives in its own `@/`-free module
 *     so the desktop daemon factory (`./desktop-factory.ts`) can pull it WITHOUT
 *     dragging this file's cluster `@/*` imports into the daemon bundle.
 */

import type {
  OrganizationScope,
  StudioContext,
} from "../../core/studio-context";
import { monitorLlmCall } from "@/monitoring/emit-llm-call";
import { recordLlmCallMetrics } from "@/monitoring/record-llm-call-metrics";
import type { VirtualMCPEntity } from "@/tools/virtual/schema";
import { createVirtualClientFrom } from "@/mcp-clients/virtual-mcp";
import type { SideChannelWriter } from "../side-channel-writer";
import { assembleDecopilotTools } from "./tools";
import { createHtmlPageBuffer } from "./built-in-tools/vm-tools/html-page-buffer";
import type { PendingImage } from "./built-in-tools";
import type { DecopilotToolRuntime, ModelRuntime } from "./run-core";
import type {
  AssembledEngineHandle,
  HarnessAssembledTools,
  RunEngineArgs,
} from "./engine";
import { runAgentLoop } from "./run-agent-loop";
import type { DecopilotTelemetry } from "./run-stream";

/**
 * Cluster engine adapter: maps the portable `RunEngineArgs` onto the ctx-coupled
 * `runAgentLoop` (which owns system-prompt assembly + tool assembly + the
 * native streamText loop). Closes over `ctx` + `organization`. No behavior
 * change — the same `runAgentLoop` call the cluster factory made before the
 * unification, with the parent-supplied args threaded through.
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
    user: args.user,
    userContext: args.userContext,
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

/**
 * Build the CLUSTER environment deps: the StudioContext-backed tool runtime
 * (in-process virtual-MCP passthrough + full cluster built-ins + the per-run
 * html-page buffer) and the cluster telemetry sink. `cleanup.close` is assigned
 * inside `buildEnvironmentTools` so the factory's `finally` can close the live
 * passthrough client even if the core throws mid-stream.
 */
export function buildClusterEnvironmentTools(args: {
  ctx: StudioContext;
  organization: OrganizationScope;
  modelRuntime: ModelRuntime;
  sideChannel: SideChannelWriter;
  cleanup: { close?: () => Promise<void> };
}): { toolRuntime: DecopilotToolRuntime; telemetry: DecopilotTelemetry } {
  const { ctx, organization, modelRuntime, sideChannel, cleanup } = args;
  const htmlPageBuffer = createHtmlPageBuffer(ctx, sideChannel.writer);

  const toolRuntime: DecopilotToolRuntime = {
    buildEnvironmentTools: async ({ input: streamInput, onChildUsage }) => {
      const toolOutputMap = new Map<string, string>();
      const pendingImages: PendingImage[] = [];
      const assembled = await assembleDecopilotTools(streamInput, ctx, {
        writer: sideChannel.writer,
        toolOutputMap,
        pendingImages,
        threadId: streamInput.threadId,
        // Cluster `mcpForAgent` hook: opens the in-process passthrough
        // client over the run's resolved Virtual MCP. superUser/listTimeout
        // come from the caller (assembleDecopilotTools). The daemon/desktop
        // factory supplies an HTTP-backed impl at the agent's mcp.url.
        mcpForAgent: (_agentId, opts) =>
          createVirtualClientFrom(
            // Cluster-side: `virtualMcp` is the real `VirtualMCPEntity`;
            // the transport type widens the field to a loose bag so the
            // daemon can ship without the cluster's storage types.
            streamInput.virtualMcp as VirtualMCPEntity,
            ctx,
            "passthrough",
            opts?.superUser ?? false,
            { listTimeoutMs: opts?.listTimeoutMs },
          ),
        provider: modelRuntime.thinking.provider,
        imageProvider:
          modelRuntime.image?.provider ?? modelRuntime.thinking.provider,
        deepResearchProvider:
          modelRuntime.deepResearch?.provider ?? modelRuntime.thinking.provider,
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
    runEngine: (engineArgs) => runClusterEngine(ctx, organization, engineArgs),
  };

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

  return { toolRuntime, telemetry };
}

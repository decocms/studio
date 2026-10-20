/**
 * Studio's concrete Decopilot environment-deps assembler.
 *
 * The Decopilot harness runs ONE orchestration loop (`runDecopilotCore`). The
 * stream executor gets its StudioContext-backed `DecopilotToolRuntime` and
 * telemetry directly from this cluster assembler:
 *
 *   - the in-process virtual-MCP passthrough client + the full cluster tool set
 *     (web_search / update_interests / the portable built-ins) + the per-run
 *     HTML-artifact buffer/watcher, plus the ctx-coupled `runAgentLoop` engine.
 */

import type {
  OrganizationScope,
  StudioContext,
} from "../../core/studio-context";
import { monitorLlmCall } from "@/monitoring/emit-llm-call";
import { recordLlmCallMetrics } from "@/monitoring/record-llm-call-metrics";
import type { SideChannelWriter } from "@/harnesses/lib/side-channel-writer";
import { assembleDecopilotTools } from "./tools";
import { createHtmlArtifactBuffer } from "./built-in-tools/vm-tools/html-artifact-buffer";
import { createHtmlArtifactWatcher } from "@/harnesses/html-artifact-watcher";
import { createToolOutputMap } from "@/harnesses/lib/decopilot/built-in-tools/read-tool-output";
import type { PendingImage } from "./built-in-tools";
import type {
  DecopilotToolRuntime,
  ModelRuntime,
} from "@/harnesses/lib/decopilot/run-core";
import type {
  AssembledEngineHandle,
  HarnessAssembledTools,
  RunEngineArgs,
} from "@/harnesses/lib/decopilot/engine";
import { runAgentLoop } from "./run-agent-loop";
import type { DecopilotTelemetry } from "@/harnesses/lib/decopilot/run-stream";
import { createBackgroundToolDispatcher } from "./background-tool-workflow";
import { requireDecopilotRunContext } from "@/harnesses/lib/decopilot/run-context";

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
    codingWorkspace: args.codingWorkspace,
    writer: args.writer,
    subtaskParams: {
      provider: args.provider,
      organization,
      models: args.models,
      codingWorkspace: args.codingWorkspace,
    },
    prepareStep: args.prepareStep,
    onStepFinish: args.onStepFinish,
    passthroughClient: args.passthroughClient,
    connectionsData: args.connectionsData,
    extraTools: args.extraTools,
    toolOutputMap: args.toolOutputMap,
    additionalSystemMessages: args.additionalSystemMessages,
    activeToolNames: args.activeToolNames,
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
 * HTML-artifact buffer) and the cluster telemetry sink. `cleanup.close` is assigned
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
  // Live HTML-artifact previews: change-feed watcher emitting `data-deck-updated`
  // parts for `decks/`|`pages/` writes in the org home volume, plus the
  // write/edit fast-path mirror that lands tool content in org-fs at step end
  // (ahead of the mount's slow vfs write-back).
  const htmlArtifactWatcher = createHtmlArtifactWatcher(
    ctx,
    sideChannel.writer,
  );
  const htmlArtifactBuffer = createHtmlArtifactBuffer(ctx);

  const toolRuntime: DecopilotToolRuntime = {
    buildEnvironmentTools: async ({ input: streamInput, onChildUsage }) => {
      const runContext = requireDecopilotRunContext(streamInput);
      const toolOutputMap = createToolOutputMap();
      const pendingImages: PendingImage[] = [];

      const assembled = await assembleDecopilotTools(streamInput, ctx, {
        writer: sideChannel.writer,
        toolOutputMap,
        pendingImages,
        threadId: streamInput.threadId,
        provider: modelRuntime.thinking.provider,
        imageProvider:
          modelRuntime.image?.provider ?? modelRuntime.thinking.provider,
        webSearchProvider:
          modelRuntime.webSearch?.provider ?? modelRuntime.thinking.provider,
        deepResearchProvider:
          modelRuntime.deepResearch?.provider ?? modelRuntime.thinking.provider,
        // Hosted cluster runs get a DBOS-backed background dispatcher so slow
        // built-ins (generate_image) don't freeze the turn. The reaction turn
        // is rebuilt on any pod from this serializable snapshot.
        backgroundDispatcher: createBackgroundToolDispatcher({
          threadId: streamInput.threadId,
          orgId: streamInput.organizationId,
          userId: streamInput.user.id,
          agentId: streamInput.agent.id,
          temperature: streamInput.temperature,
          toolApprovalLevel: streamInput.toolApprovalLevel,
          branch: runContext.branch ?? null,
          runMetadata: ctx.metadata.runMetadata,
        }),
        htmlArtifactBuffer,
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
        toolOutputMap,
        writer: sideChannel.writer,
        pendingImages,
        sideChunks: sideChannel.stream,
        closeSideChunks: sideChannel.close,
        onStepFinish: async () => {
          // Fast-path mirror must land before the sweep so the change-feed
          // entry it creates is picked up in the same step. Both swallow
          // their own errors; late rclone write-backs are caught by the next
          // step's sweep or the tab's stat poll.
          await htmlArtifactBuffer.flush();
          await htmlArtifactWatcher.sweep();
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

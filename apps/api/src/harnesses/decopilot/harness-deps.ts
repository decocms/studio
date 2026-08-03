/**
 * Hosted Decopilot environment.
 *
 * The Decopilot harness runs ONE orchestration loop (`runDecopilotCore`). The
 * This builds the StudioContext-backed `DecopilotToolRuntime` and telemetry:
 *
 *   - the in-process virtual-MCP passthrough client + the full hosted tool set
 *     (web_search / update_interests / Browserless built-ins) + the per-run
 *     HTML-artifact buffer/watcher, plus the ctx-coupled `runAgentLoop` engine.
 */

import type {
  OrganizationScope,
  StudioContext,
} from "../../core/studio-context";
import { monitorLlmCall } from "@/monitoring/emit-llm-call";
import { recordLlmCallMetrics } from "@/monitoring/record-llm-call-metrics";
import type { ConnectionEntity } from "@/tools/connection/schema";
import { createVirtualClientFrom } from "@/mcp-clients/virtual-mcp";
import { resolveDevConnection } from "@/api/routes/dev-connection";
import type { SideChannelWriter } from "@/harnesses/lib/side-channel-writer";
import { assembleDecopilotTools } from "./tools";
import { buildHostedMcpToolHooks } from "@/api/routes/decopilot/mcp-tool-hooks";
import { createHtmlArtifactBuffer } from "./built-in-tools/vm-tools/html-artifact-buffer";
import { createHtmlArtifactWatcher } from "./built-in-tools/vm-tools/html-artifact-watcher";
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

/**
 * Hosted engine adapter: maps `RunEngineArgs` onto the ctx-coupled
 * `runAgentLoop` (which owns system-prompt assembly + tool assembly + the
 * native streamText loop). It closes over `ctx` and `organization`.
 */
async function runHostedEngine(
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
 * Build the hosted environment: the StudioContext-backed tool runtime
 * (in-process virtual-MCP passthrough + hosted built-ins + the per-run
 * HTML-artifact buffer) and telemetry sink. `cleanup.close` is assigned
 * inside `buildEnvironmentTools` so the factory's `finally` can close the live
 * passthrough client even if the core throws mid-stream.
 */
export function buildHostedDecopilotEnvironment(args: {
  ctx: StudioContext;
  modelRuntime: ModelRuntime;
  sideChannel: SideChannelWriter;
  cleanup: { close?: () => Promise<void> };
}): { toolRuntime: DecopilotToolRuntime; telemetry: DecopilotTelemetry } {
  const { ctx, modelRuntime, sideChannel, cleanup } = args;
  const organization = ctx.organization;
  if (!organization) {
    throw new Error("[decopilot] organization context is required");
  }
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
    buildEnvironmentTools: async ({
      input: streamInput,
      runContext,
      onChildUsage,
    }) => {
      const toolOutputMap = new Map<string, string>();
      const pendingImages: PendingImage[] = [];
      const { resolveArgs, onToolCalled, onPrOpened } = buildHostedMcpToolHooks(
        ctx,
        streamInput.threadId,
      );

      const assembled = await assembleDecopilotTools(
        streamInput,
        runContext,
        ctx,
        {
          writer: sideChannel.writer,
          toolOutputMap,
          pendingImages,
          threadId: streamInput.threadId,
          // Hosted MCP tool-call hooks: storage-ref resolution + PostHog
          // analytics. Tool assembly forwards these as-is.
          resolveArgs,
          onToolCalled,
          onPrOpened,
          // Opens the in-process passthrough client over the authoritative
          // Virtual MCP in DecopilotRunContext. superUser/listTimeout come
          // from the caller (assembleDecopilotTools).
          openMcp: async (opts) => {
            // The run context carries the complete persisted Virtual MCP.
            const vm = runContext.virtualMcp;
            // Surface tools from the run's hosted dev sandbox when it actually
            // speaks MCP. The resolver owns thread-scoped record lookup.
            let devConnection: ConnectionEntity | null = null;
            if (vm.id && streamInput.user.id) {
              devConnection = await resolveDevConnection(
                ctx,
                vm.id,
                streamInput.user.id,
                runContext.branch ?? undefined,
              ).catch(() => null);
            }
            return createVirtualClientFrom(vm, ctx, opts?.superUser ?? false, {
              listTimeoutMs: opts?.listTimeoutMs,
              includeSkillsCatalog: true,
              additionalConnections: devConnection ? [devConnection] : [],
            });
          },
          provider: modelRuntime.thinking.provider,
          imageProvider:
            modelRuntime.image?.provider ?? modelRuntime.thinking.provider,
          webSearchProvider:
            modelRuntime.webSearch?.provider ?? modelRuntime.thinking.provider,
          deepResearchProvider:
            modelRuntime.deepResearch?.provider ??
            modelRuntime.thinking.provider,
          // Hosted runs get a DBOS-backed background dispatcher so slow
          // built-ins (generate_image) don't freeze the turn. The reaction turn
          // is rebuilt on any pod from this serializable snapshot.
          backgroundDispatcher: createBackgroundToolDispatcher({
            threadId: streamInput.threadId,
            orgId: streamInput.organizationId,
            userId: streamInput.user.id,
            temperature: streamInput.temperature,
            toolApprovalLevel: streamInput.toolApprovalLevel,
            branch: runContext.branch ?? null,
          }),
          htmlArtifactBuffer,
          // Roll subtask child usage into the parent run's accumulator
          // (Task 17). Threaded into the subtask tool via getBuiltInTools.
          onChildUsage,
        },
      );
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
    runEngine: (engineArgs) => runHostedEngine(ctx, organization, engineArgs),
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

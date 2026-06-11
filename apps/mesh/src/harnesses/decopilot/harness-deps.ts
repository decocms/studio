/**
 * Unified Decopilot environment-deps assemblers (spec §5.2/§9 — "ONE factory").
 *
 * The Decopilot harness runs ONE orchestration loop (`runDecopilotCore`); the
 * only difference between the cluster and the desktop daemon is which
 * `DecopilotToolRuntime` + `telemetry` the environment builds. This module owns
 * those two branches as flat assemblers so the single `decopilotHarnessFactory`
 * can select between them by inspecting the injected context shape:
 *
 *   - `buildClusterEnvironmentTools` — the StudioContext-backed branch: the
 *     in-process virtual-MCP passthrough client + the full cluster tool set
 *     (web_search / update_interests / Browserless built-ins) + the per-run
 *     html-page buffer, plus the ctx-coupled `runAgentLoop` engine.
 *   - `buildDesktopEnvironmentTools` — the import-isolated daemon branch: an
 *     HTTP MCP passthrough client + the local-OK built-ins + the portable
 *     `runNativeAgentLoopCore` engine with a cluster-storage-free system prompt.
 *
 * Both return a `DecopilotToolRuntime` (the `buildEnvironmentTools` +
 * `runEngine` seam `runDecopilotCore` consumes); the cluster assembler also
 * returns its telemetry sink. Behavior is byte-identical to the two forks they
 * replace — the bodies are lifted verbatim from the cluster `index.ts` factory
 * and the desktop `createDesktopToolRuntime`.
 */

import type {
  OrganizationScope,
  StudioContext,
} from "../../core/studio-context";
import { monitorLlmCall } from "@/monitoring/emit-llm-call";
import { recordLlmCallMetrics } from "@/monitoring/record-llm-call-metrics";
import type { VirtualMCPEntity } from "@/tools/virtual/schema";
import { createVirtualClientFrom } from "@/mcp-clients/virtual-mcp";
import type { HarnessStreamInput } from "../types";
import {
  createSideChannelWriter,
  type SideChannelWriter,
} from "../side-channel-writer";
import { assembleDecopilotTools } from "./tools";
import { createHtmlPageBuffer } from "./built-in-tools/vm-tools/html-page-buffer";
import type { PendingImage } from "./built-in-tools";
import {
  createDesktopToolRuntime,
  resolveDesktopRuntimeSources,
} from "../decopilot-desktop/index";
import type { OpenMcpSourceOptions } from "../sources";
import { createLocalSubtaskTool } from "./built-in-tools/local-subtask";
import { swapVirtualMcpAgent } from "../decopilot-desktop/swap-virtual-mcp-agent";
import type { DecopilotHttpMcpSource } from "../types";
import {
  spawnSubtask,
  type DecopilotToolRuntime,
  type ModelRuntime,
  type RunDecopilotCoreDeps,
  type SubtaskRunResult,
} from "./run-core";
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

/**
 * Build the DESKTOP environment deps: the HTTP-passthrough + local-built-ins
 * tool runtime, including the real desktop-local `subtask` tool (self +
 * cross-agent — Task 18). `telemetry` is undefined for the desktop (runs stay
 * OTel-invisible this phase). `cleanup.close` is assigned inside
 * `buildEnvironmentTools` so the factory's `finally` closes the MCP client.
 *
 * The body is lifted verbatim from the desktop factory's `stream` wiring: it
 * builds a parent `createDesktopToolRuntime`, threads the subtask tool's
 * `runSubtask` closure (which swaps the virtual-MCP agent path segment for
 * cross-agent delegation and runs `spawnSubtask`), and captures the core's
 * child-usage sink so child runs fold into the parent accumulator.
 *
 * `openHttp` is the test seam that lets the parity test inject a fake MCP
 * `Client`; production leaves it undefined so `openMcpSource` opens the real
 * Streamable-HTTP transport.
 */
export function buildDesktopEnvironmentTools(args: {
  input: HarnessStreamInput;
  modelRuntime: ModelRuntime;
  sideChannel: SideChannelWriter;
  cleanup: { close?: () => Promise<void> };
  openHttp?: OpenMcpSourceOptions["openHttp"];
}): DecopilotToolRuntime {
  const { input, modelRuntime, sideChannel, cleanup, openHttp } = args;
  const { mcpSource } = resolveDesktopRuntimeSources(input);

  // ── Local subtask (Task 18) — self + cross-agent. Builds TARGET-agent
  //    core deps and runs the shared core via spawnSubtask. ────────────────
  const runSubtask = async (
    prompt: string,
    targetAgentId: string | undefined,
    signal: AbortSignal,
  ): Promise<SubtaskRunResult> => {
    const targetUrl = swapVirtualMcpAgent(mcpSource.url, targetAgentId);
    const targetMcpSource: DecopilotHttpMcpSource = {
      kind: "http",
      url: targetUrl,
      headers: mcpSource.headers,
      expiresAt: mcpSource.expiresAt,
    };
    const subSideChannel = createSideChannelWriter();
    const subCleanup: { close?: () => Promise<void> } = {};
    const targetInput: HarnessStreamInput = targetAgentId
      ? {
          ...input,
          agent: { id: targetAgentId },
          virtualMcp: { ...input.virtualMcp, id: targetAgentId },
        }
      : input;
    const targetToolRuntime = createDesktopToolRuntime({
      input: targetInput,
      mcpSource: targetMcpSource,
      modelRuntime,
      sideChannel: subSideChannel,
      cleanup: subCleanup,
      agentOverride: targetAgentId ? { id: targetAgentId } : undefined,
      openHttp,
      // depth-1: a delegated run NEVER gets its own subtask tool. The
      // core also strips it (kind:"subtask"); this is belt-and-braces.
    });
    const deps: Omit<RunDecopilotCoreDeps, "kind"> = {
      input: targetInput,
      modelRuntime,
      toolRuntime: targetToolRuntime,
      telemetry: undefined,
    };
    try {
      return await spawnSubtask({ prompt, deps, signal });
    } finally {
      subSideChannel.close();
      await subCleanup.close?.().catch(() => {});
    }
  };

  // The core supplies its usage roll-up sink to buildEnvironmentTools
  // (`onChildUsage`, for kind:"main"). Capture it so the locally-built
  // subtask tool — created BEFORE buildEnvironmentTools runs — can fold
  // each child run's usage into the SAME accumulator that builds the
  // parent's final `message-metadata.usage` (parity with the cluster).
  let parentOnChildUsage:
    | ((usage: SubtaskRunResult["usage"]) => void)
    | undefined;

  const subtaskTool = createLocalSubtaskTool({
    writer: sideChannel.writer,
    selfAgentId: input.agent.id,
    models: input.models,
    needsApproval: input.mode === "plan" || input.toolApprovalLevel !== "auto",
    runSubtask,
    onChildUsage: (usage) => parentOnChildUsage?.(usage),
  });

  const parentToolRuntime = createDesktopToolRuntime({
    input,
    mcpSource,
    modelRuntime,
    sideChannel,
    cleanup,
    subtask: subtaskTool,
    openHttp,
  });

  return {
    buildEnvironmentTools: (buildArgs) => {
      parentOnChildUsage = buildArgs.onChildUsage;
      return parentToolRuntime.buildEnvironmentTools(buildArgs);
    },
    runEngine: parentToolRuntime.runEngine,
  };
}

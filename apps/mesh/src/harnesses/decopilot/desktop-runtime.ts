/**
 * desktop-runtime — the import-isolated DESKTOP tool-runtime for the shared
 * Decopilot core. Runs INSIDE the desktop daemon (`packages/sandbox/daemon`) and
 * is ALSO consumed by the unified cluster factory's desktop branch
 * (`decopilot/index.ts` → `buildDesktopEnvironmentTools`).
 *
 * Like the cluster path, the desktop path builds the environment-specific deps
 * and hands them to `runDecopilotCore` (`./run-core`) — ONE loop drives both
 * environments. Unlike the cluster (which threads the full `StudioContext`,
 * vault, storage, run-registry, and OTel monitoring), this module:
 *   - activates the chat provider from the injected `modelSources` secrets
 *     (`buildModelRuntimeFromSources` + `createProviderFromSecret`) instead of
 *     `ctx.aiProviders.activate` + vault;
 *   - opens an HTTP MCP `Client` to `mcp.url` and exposes its tools as
 *     passthrough tools (`toolsFromMCP`);
 *   - assembles only the LOCAL-OK built-ins (`buildLocalTools`) — the cluster
 *     built-ins are reached through `mcp.url` as passthrough tools;
 *   - runs `runEngine` against the PORTABLE `runNativeAgentLoopCore` with a
 *     DESKTOP system prompt (`buildDesktopPrompt`) — NOT the cluster's
 *     ctx-coupled `runAgentLoop` / `buildAgentSystemPrompt`, so neither of those
 *     enters the daemon bundle;
 *   - passes `telemetry: undefined` — desktop runs stay OTel-invisible this
 *     phase (no `@/monitoring` sink, no run-registry coupling). The engine still
 *     returns a no-op OTel span so the shared loop's span attributes are safe.
 *   - implements a REAL local `subtask` (self + cross-agent) by building
 *     TARGET-agent core deps and calling `spawnSubtask` — the cluster
 *     `SUBTASK_MCP` relay is gone.
 *
 * It imports ONLY portable leaves (relative paths) + `../types`. No `@/*`
 * specifier and no `StudioContext` ever enters this graph, so the daemon bundles
 * it and `tsc` does not overflow.
 *
 * ⚠️ SECURITY: each `modelSources` slot (kind="secret") carries an org
 * chat-completion API key in plaintext over HTTPS. Never log it. Hardening
 * (cluster model-proxy, spec §3.9) is deferred.
 */

import { stepCountIs, type ToolSet } from "ai";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { trace } from "@opentelemetry/api";
import type {
  DecopilotHttpMcpSource,
  DecopilotSecretModelSource,
  HarnessStreamInput,
} from "@decocms/harness/types";
import {
  openMcpSource,
  openObjectStorageSource,
  type OpenMcpSourceOptions,
} from "@decocms/harness/sources";
import { createLanguageModel } from "@decocms/harness/decopilot/mesh-provider";
import { toolsFromMCP } from "@decocms/harness/decopilot/mcp-tools";
import { buildLocalTools } from "./desktop-local-tools";
import { getDesktopSandboxFsBuilder } from "@decocms/harness/decopilot/desktop-sandbox-fs-registry";
import { buildDesktopPrompt, PARENT_STEP_LIMIT } from "./desktop-prompt";
import { resolveModeConfig } from "@decocms/harness/decopilot/mode-config";
import { runNativeAgentLoopCore } from "@decocms/harness/decopilot/native-agent-loop-core";
import {
  spawnSubtask,
  type DecopilotToolRuntime,
  type ModelRuntime,
  type RunDecopilotCoreDeps,
  type SubtaskRunResult,
} from "@decocms/harness/decopilot/run-core";
import type {
  AssembledEngineHandle,
  HarnessAssembledTools,
  RunEngineArgs,
} from "@decocms/harness/decopilot/engine";
import type { ConnectionsBlockTool } from "@decocms/harness/decopilot/connections-block";
import type { VirtualClient } from "@decocms/harness/decopilot/built-in-tools/sandbox";
import type { PendingImage } from "@decocms/harness/decopilot/built-in-tools/vm-tools/types";
import { createLocalSubtaskTool } from "@decocms/harness/decopilot/built-in-tools/local-subtask";
import type { DesktopToolCtx } from "./desktop-tool-ctx";
import { createHtmlPageBufferFromStorage } from "@decocms/harness/decopilot/built-in-tools/vm-tools/html-page-buffer-core";
import {
  createSideChannelWriter,
  type SideChannelWriter,
} from "@decocms/harness/side-channel-writer";
import { swapVirtualMcpAgent } from "@decocms/harness/decopilot/swap-virtual-mcp-agent";

function isDesktopToolVisible(tool: {
  name: string;
  _meta?: Record<string, unknown>;
}): boolean {
  const ui = tool._meta?.ui as { visibility?: string | string[] } | undefined;
  const visibility = ui?.visibility;
  if (visibility == null) return true;
  if (typeof visibility === "string") return visibility === "model";
  if (Array.isArray(visibility)) return visibility.includes("model");
  return true;
}

export function resolveDesktopRuntimeSources(input: HarnessStreamInput): {
  modelSource: DecopilotSecretModelSource;
  mcpSource: DecopilotHttpMcpSource;
} {
  const modelSource =
    input.modelSources?.thinking?.kind === "secret"
      ? input.modelSources.thinking
      : null;
  if (!modelSource) {
    throw new Error(
      "decopilot-desktop requires a secret thinking model source. The cluster " +
        "must inject the chat-model credential when routing decopilot to " +
        "user-desktop.",
    );
  }

  const mcpSource =
    input.mcpSource?.kind === "http"
      ? input.mcpSource
      : {
          kind: "http" as const,
          url: input.mcp.url,
          headers: input.mcp.headers,
          expiresAt: input.mcp.expiresAt,
        };

  return { modelSource, mcpSource };
}

/**
 * Desktop engine adapter: assembles the DESKTOP system prompt
 * (`buildDesktopPrompt` — the cluster-storage-free prompt) + the desktop tool
 * set and drives the PORTABLE `runNativeAgentLoopCore`. Closes over the
 * per-run assembled tool bundle (passthrough tools + local tools +
 * connections data, built in `buildEnvironmentTools`) the same way the cluster
 * closure captures `ctx`.
 *
 * The shared loop (`run-stream`) passes the portable `RunEngineArgs`:
 *   - `messages` / `provider` / `models` / `temperature` / `abortSignal`,
 *   - `prepareStep` (image injection + plan-mode filter + enabled-tool gating),
 *   - `extraTools` (the local built-ins + state-dependent `enable_tool`),
 *   - `additionalSystemMessages` (inline <system> blocks + enabled-tools tail),
 *   - `connectionsData` / `isDecopilot` / `systemAgentInstructions` / `planMode`.
 * The full streamText tool set = passthrough (from the closure) + extraTools.
 *
 * `stepLimit` (set to `SUBAGENT_STEP_LIMIT` for `kind: "subtask"` core runs)
 * overrides the default `PARENT_STEP_LIMIT` stop condition.
 *
 * No telemetry, no run-registry, no monitoring — the engine returns a no-op
 * OTel span so the shared loop's span attribute writes are harmless.
 */
function runDesktopEngine(
  closure: {
    input: HarnessStreamInput;
    passthroughTools: ToolSet;
  },
  args: RunEngineArgs,
): AssembledEngineHandle {
  const { input } = closure;
  // resolveModeConfig is the source of planPrompt/webSearchInstructionPrompt
  // strings; args.planMode === (input.mode === "plan") for the boolean guard.
  const modeConfig = resolveModeConfig(input.mode, { isCliAgent: false });

  // ── DESKTOP system prompt (cluster-storage-free) ──────────────────────
  const prompt = buildDesktopPrompt({
    agentId: args.virtualMcp.id,
    isDecopilotAgent: args.isDecopilot,
    connectionsBlockTools: args.connectionsData.tools,
    connectionTitleMap: args.connectionsData.connectionTitleMap,
    agentInstructions: args.systemAgentInstructions,
    planPrompt: modeConfig.planPrompt,
    webSearchPrompt: modeConfig.webSearchInstructionPrompt,
  });
  // Append the per-request inline <system> blocks + enabled-tools tail the
  // loop reconstructed (mirrors the cluster runAgentLoop's
  // `additionalSystemMessages` append after buildAgentSystemPrompt).
  const systemMessages = [
    ...prompt.systemMessages,
    ...args.additionalSystemMessages,
  ];

  // ── Tool set: passthrough (closure) + extraTools (local built-ins +
  //    enable_tool). Mirrors run-stream's streamTools ordering. ──────────
  const tools: ToolSet = {
    ...closure.passthroughTools,
    ...args.extraTools,
  };

  // No tracer on the desktop — a getTracer span is a no-op without a
  // registered SDK, satisfying the shared loop's `handle.span.setAttribute`.
  const span = trace
    .getTracer("decopilot-desktop")
    .startSpan("decopilot.agent_loop", {
      attributes: {
        "decopilot.agent.id": args.virtualMcp.id,
        "decopilot.agent.kind": args.kind,
        "decopilot.organization.id": input.organizationId,
        "decopilot.model.id": args.models.thinking.id,
      },
    });

  const model = createLanguageModel(args.provider, args.models.thinking);
  const handle = runNativeAgentLoopCore({
    model,
    systemMessages,
    messages: args.messages,
    tools,
    prepareStep: args.prepareStep,
    temperature: args.temperature,
    maxOutputTokens: args.models.thinking.limits?.maxOutputTokens ?? 32768,
    // Delegated subtask core runs cap at SUBAGENT_STEP_LIMIT (args.stepLimit);
    // top-level runs fall back to PARENT_STEP_LIMIT.
    stopWhen: stepCountIs(args.stepLimit ?? PARENT_STEP_LIMIT),
    abortSignal: args.abortSignal,
    onStepFinish: args.onStepFinish,
    onError: (_message, error) => {
      console.error("[decopilot-desktop] stream error", error);
    },
  });

  Promise.resolve(handle.result.finishReason).finally(() => span.end());

  return {
    result: handle.result,
    error: handle.error,
    span,
    assembledSystemMessages: systemMessages,
  };
}

/**
 * Build a desktop `DecopilotToolRuntime` for one MCP endpoint. Shared by the
 * top-level run (parent's `mcpSource`) and a cross-agent subtask (the TARGET
 * agent's swapped virtual-MCP URL). Owns the per-runtime MCP-client lifecycle
 * (assigned into `cleanup.close`); the caller runs `cleanup.close` in its
 * `finally`.
 *
 * `agentOverride`, when present, makes `buildEnvironmentTools` build the desktop
 * built-ins for the TARGET agent id (so `read_resource`/`sandbox`/etc. scope to
 * the target) and `runEngine` assemble the prompt with the TARGET's
 * server-provided instructions read from the target MCP client
 * (`getInstructions()`), and report the target id on the span. The shared core
 * passes `subtask: undefined` for these runs anyway (depth-1 strip), so the
 * target toolset never re-exposes `subtask`.
 */
function createDesktopToolRuntime(args: {
  input: HarnessStreamInput;
  mcpSource: DecopilotHttpMcpSource;
  modelRuntime: ModelRuntime;
  sideChannel: SideChannelWriter;
  cleanup: { close?: () => Promise<void> };
  /** Cross-agent subtask: override the agent id the desktop tools + prompt
   *  scope to. Omitted for the parent run and self-clone subtasks. */
  agentOverride?: { id: string };
  /** The real local `subtask` tool, injected only into the parent run's
   *  toolset (depth-1 — never into a delegated subtask runtime). */
  subtask?: ReturnType<typeof createLocalSubtaskTool>;
  /** Test-only seam: override how the HTTP MCP source is opened so the parity
   *  test can inject a fake MCP `Client` without a real network connection.
   *  Production leaves this undefined and `openMcpSource` opens the real
   *  Streamable-HTTP transport. */
  openHttp?: OpenMcpSourceOptions["openHttp"];
}): DecopilotToolRuntime {
  const { input, mcpSource, modelRuntime, sideChannel, cleanup } = args;
  const imageProvider =
    modelRuntime.image?.provider ?? modelRuntime.thinking.provider;
  // The agent the desktop tools + prompt scope to. The parent uses the run's
  // own agent; a cross-agent subtask overrides it with the target id.
  const targetAgentId = args.agentOverride?.id ?? input.agent.id;

  // passthroughTools is set by buildEnvironmentTools and consumed by runEngine.
  // The sentinel `undefined` (not `{}`) distinguishes "not yet built" from
  // "legitimately empty passthrough set", so runEngine can guard against
  // temporal coupling if the call order ever breaks. `serverInstructions` is
  // captured the same way (target prompt needs the target MCP's instructions).
  let builtPassthroughTools: ToolSet | undefined = undefined;
  let builtServerInstructions: string | undefined = undefined;

  return {
    buildEnvironmentTools: async ({ input: streamInput }) => {
      const toolOutputMap = new Map<string, string>();
      const pendingImages: PendingImage[] = [];

      // 1. Open the MCP client to the (parent or target) virtual-mcp endpoint.
      const openedMcp = await openMcpSource(mcpSource, {
        clientInfo: { name: "decopilot-desktop", version: "1" },
        openHttp: args.openHttp,
      });
      const mcpClient = openedMcp.client as Client;
      cleanup.close = openedMcp.close;

      try {
        // 2. Passthrough tools from the MCP endpoint.
        const { tools: passthroughTools, nameMap } = await toolsFromMCP(
          mcpClient,
          toolOutputMap,
          undefined,
          streamInput.toolApprovalLevel,
          {
            isPlanMode: streamInput.mode === "plan",
            isToolVisible: isDesktopToolVisible,
          },
        );

        // 3. Connections-block list + read-only annotations from the raw
        //    listing (drives enable_tool + the connections prompt block +
        //    plan-mode gating).
        const passthroughToolList = (await mcpClient.listTools()).tools;
        const connectionsBlockTools: ConnectionsBlockTool[] = [];
        const toolAnnotations = new Map<string, { readOnlyHint?: boolean }>();
        for (const t of passthroughToolList) {
          const safeName = nameMap.get(t.name);
          if (!safeName) continue;
          const connectionId =
            typeof t._meta?.gatewayClientId === "string"
              ? t._meta.gatewayClientId
              : "unknown";
          connectionsBlockTools.push({
            rawName: t.name,
            safeName,
            connectionId,
          });
          if (t.annotations?.readOnlyHint !== undefined) {
            toolAnnotations.set(safeName, {
              readOnlyHint: t.annotations.readOnlyHint,
            });
          }
        }

        // 4. LOCAL-OK built-in tools (+ html-page buffer flush hook).
        const objectStorage = await openObjectStorageSource(
          streamInput.objectStorageSource,
        );
        const orgSlug = streamInput.organizationSlug ?? streamInput.projectSlug;
        const baseUrl = streamInput.objectStorageSource
          ? new URL(streamInput.objectStorageSource.baseUrl).origin
          : "";
        const htmlPageBuffer = createHtmlPageBufferFromStorage({
          storage: objectStorage,
          baseUrl,
          orgSlug,
          writer: sideChannel.writer,
          logPrefix: "decopilot-desktop:html-page-buffer",
        });
        const toolCtx: DesktopToolCtx = {
          objectStorage,
          organization: { id: streamInput.organizationId, slug: orgSlug },
          auth: { user: { id: streamInput.user.id } },
          baseUrl,
        };
        // Flat sandbox fs hooks built by the desktop glue (owns the
        // `@decocms/sandbox` provider) so buildLocalTools stays sandbox-free.
        const fs = getDesktopSandboxFsBuilder()({
          virtualMcpId: targetAgentId,
          branch: streamInput.branch,
          userId: streamInput.user.id,
        });
        const localTools = buildLocalTools({
          writer: sideChannel.writer,
          toolOutputMap,
          passthroughClient: mcpClient as unknown as VirtualClient,
          toolApprovalLevel: streamInput.toolApprovalLevel,
          isPlanMode: streamInput.mode === "plan",
          ctx: toolCtx,
          imageProvider,
          imageModelInfo: streamInput.models.image,
          pendingImages,
          threadId: streamInput.threadId,
          // VM/sandbox + prompt scope to the target agent (parent or subtask).
          virtualMcpId: targetAgentId,
          fs,
          htmlPageBuffer,
          // Real desktop-local subtask, only on the parent run. Absent on
          // delegated subtask runtimes (depth-1; the core strips it too).
          subtask: args.subtask,
        });

        // Server instructions for the prompt: read from the live MCP client so
        // a cross-agent subtask gets the TARGET agent's identity, not the
        // parent's. (`getInstructions()` reflects the connected endpoint.)
        const serverInstructions = mcpClient.getInstructions() ?? undefined;

        // Stash for runDesktopEngine. The undefined→value transition is the
        // type-enforced gate: runEngine throws if these were never assigned.
        builtPassthroughTools = passthroughTools;
        builtServerInstructions = serverInstructions;

        const bundle: HarnessAssembledTools = {
          tools: { ...passthroughTools, ...localTools },
          passthroughTools,
          builtInTools: localTools,
          connectionsBlockTools,
          toolAnnotations,
          connectionTitleMap: new Map(),
          serverInstructions,
          passthroughClient: mcpClient,
          writer: sideChannel.writer,
          pendingImages,
          sideChunks: sideChannel.stream,
          closeSideChunks: sideChannel.close,
          onStepFinish: async () => {
            await htmlPageBuffer.flush().catch((err) => {
              console.error("[decopilot-desktop] html-page flush failed", err);
            });
          },
          close: openedMcp.close,
        };
        return bundle;
      } catch (err) {
        // Construction failed mid-way — close the MCP client we already opened
        // so the session doesn't leak, then re-throw.
        await openedMcp.close().catch(() => {});
        cleanup.close = undefined;
        throw err;
      }
    },
    runEngine: async (engineArgs) => {
      if (builtPassthroughTools === undefined) {
        throw new Error(
          "[decopilot-desktop] runEngine called before buildEnvironmentTools — " +
            "passthroughTools not yet assembled. This is a harness wiring bug.",
        );
      }
      // For a cross-agent subtask, force the engine to assemble the prompt for
      // the TARGET agent id + its server instructions (the shared loop derives
      // these from `input.agent.id` / `tools.serverInstructions`, which already
      // reflect the override here, but the engine's `virtualMcp.id` also drives
      // the desktop identity prompt — keep it consistent).
      const scopedArgs: RunEngineArgs = args.agentOverride
        ? {
            ...engineArgs,
            virtualMcp: { ...engineArgs.virtualMcp, id: targetAgentId },
            systemAgentInstructions:
              engineArgs.systemAgentInstructions ?? builtServerInstructions,
          }
        : engineArgs;
      return runDesktopEngine(
        { input, passthroughTools: builtPassthroughTools },
        scopedArgs,
      );
    },
  };
}

/**
 * Build the DESKTOP environment deps: the HTTP-passthrough + local-built-ins
 * tool runtime, including the real desktop-local `subtask` tool (self +
 * cross-agent). `telemetry` is undefined for the desktop (runs stay
 * OTel-invisible this phase). `cleanup.close` is assigned inside
 * `buildEnvironmentTools` so the factory's `finally` closes the MCP client.
 *
 * It builds a parent `createDesktopToolRuntime`, threads the subtask tool's
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

  // ── Local subtask — self + cross-agent. Builds TARGET-agent core deps and
  //    runs the shared core via spawnSubtask. ──────────────────────────────
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

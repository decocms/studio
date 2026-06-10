/**
 * decopilot-desktop harness — the import-isolated DESKTOP ADAPTER for the shared
 * Decopilot core. Runs INSIDE the desktop daemon (`packages/sandbox/daemon`).
 *
 * Registered in the daemon's `dispatchHarnessRegistry` under the id "decopilot".
 * Like the cluster `decopilotHarnessFactory`, this factory builds the
 * environment-specific deps and hands them to `runDecopilotCore` (`../decopilot/
 * run-core`) — ONE loop drives both environments. Unlike the cluster (which
 * threads the full `StudioContext`, vault, storage, run-registry, and OTel
 * monitoring), this factory:
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
 *
 * It imports ONLY portable leaves (relative paths) + `../types`. No `@/*`
 * specifier and no `StudioContext` ever enters this graph, so the daemon bundles
 * it and `tsc` does not overflow.
 *
 * ⚠️ SECURITY: each `modelSources` slot (kind="secret") carries an org
 * chat-completion API key in plaintext over HTTPS. Never log it. Hardening
 * (cluster model-proxy, spec §3.9) is deferred.
 */

import { stepCountIs, type ToolSet, type UIMessageChunk } from "ai";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { trace } from "@opentelemetry/api";
import type {
  DecopilotHttpMcpSource,
  DecopilotSecretModelSource,
  Harness,
  HarnessContext,
  HarnessFactory,
  HarnessStreamInput,
} from "../types";
import { openMcpSource, openObjectStorageSource } from "../sources";
import { createProviderFromSecret } from "../decopilot/provider-from-secret";
import { createLanguageModel } from "../decopilot/mesh-provider";
import { toolsFromMCP } from "../decopilot/mcp-tools";
import { buildLocalTools } from "./local-tools";
import { buildDesktopPrompt, PARENT_STEP_LIMIT } from "./local-prompt";
import { resolveModeConfig } from "../../api/routes/decopilot/mode-config";
import { runNativeAgentLoopCore } from "../decopilot/native-agent-loop-core";
import {
  buildModelRuntimeFromSources,
  runDecopilotCore,
  type DecopilotToolRuntime,
  type ModelRuntime,
} from "../decopilot/run-core";
import type {
  AssembledEngineHandle,
  HarnessAssembledTools,
  RunEngineArgs,
} from "../decopilot/engine";
import type { ConnectionsBlockTool } from "../decopilot/connections-block";
import type { VirtualClient } from "../decopilot/built-in-tools/sandbox";
import type { PendingImage } from "../decopilot/built-in-tools/vm-tools/types";
import type { DesktopToolCtx } from "./types";
import { createHtmlPageBufferFromStorage } from "../decopilot/built-in-tools/vm-tools/html-page-buffer-core";
import { createSideChannelWriter } from "../side-channel-writer";

const LOCALLY_WRAPPED_RELAY_TOOLS = new Set<string>(["SUBTASK_MCP"]);

function isDesktopToolVisible(tool: {
  name: string;
  _meta?: Record<string, unknown>;
}): boolean {
  if (LOCALLY_WRAPPED_RELAY_TOOLS.has(tool.name)) return false;
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
    stopWhen: stepCountIs(PARENT_STEP_LIMIT),
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

export const decopilotDesktopHarnessFactory: HarnessFactory = {
  id: "decopilot",
  create(_ctx: HarnessContext): Harness {
    return {
      id: "decopilot",
      async *stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
        const { mcp } = input;
        const { modelSource, mcpSource } = resolveDesktopRuntimeSources(input);

        // ── Model runtime: providers from the resolved secret sources. Never
        //    log a modelSource — each carries a provider API key. ───────────
        const modelRuntime: ModelRuntime = buildModelRuntimeFromSources(
          { models: input.models, modelSources: input.modelSources },
          createProviderFromSecret,
        );
        const imageModelSource =
          input.modelSources?.image?.kind === "secret"
            ? input.modelSources.image
            : modelSource;
        const imageProvider = createProviderFromSecret(imageModelSource);

        // Diagnostics (provider id only, never the key). On the desktop this
        // runs inside the spawned daemon, so it surfaces in the link terminal.
        console.log(
          `[decopilot-desktop] stream start provider=${modelSource.providerId} ` +
            `model=${input.models.thinking.id} mcpUrl=${mcp.url} mode=${input.mode}`,
        );

        // ── Per-run side-channel + html-page buffer (desktop lifecycle). ──
        const sideChannel = createSideChannelWriter();

        // Closure shared between buildEnvironmentTools and runEngine: the
        // engine needs the passthrough tool set the build step produced (the
        // engine merges passthrough + extraTools). Assigned inside
        // buildEnvironmentTools, read inside runEngine.
        const engineClosure: { passthroughTools: ToolSet } = {
          passthroughTools: {},
        };
        // Capture the MCP source cleanup so the finally below runs it even if
        // the core throws mid-stream.
        const cleanup: { close?: () => Promise<void> } = {};

        const toolRuntime: DecopilotToolRuntime = {
          buildEnvironmentTools: async ({ input: streamInput }) => {
            const toolOutputMap = new Map<string, string>();
            const pendingImages: PendingImage[] = [];

            // 1. Open the MCP client to the cluster's virtual-mcp endpoint.
            const openedMcp = await openMcpSource(mcpSource, {
              clientInfo: { name: "decopilot-desktop", version: "1" },
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
              const toolAnnotations = new Map<
                string,
                { readOnlyHint?: boolean }
              >();
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
              const orgSlug =
                streamInput.organizationSlug ?? streamInput.projectSlug;
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
              const localTools = buildLocalTools({
                writer: sideChannel.writer,
                toolOutputMap,
                passthroughClient: mcpClient as unknown as VirtualClient,
                toolApprovalLevel: streamInput.toolApprovalLevel,
                isPlanMode: streamInput.mode === "plan",
                ctx: toolCtx,
                // subtask runs cluster-side via the SUBTASK_MCP relay. The
                // wrapper injects these so the model never supplies
                // credential/model ids, defaulting the target to this agent.
                mcpClient,
                models: streamInput.models,
                selfAgentId: streamInput.agent.id,
                imageProvider,
                imageModelInfo: streamInput.models.image,
                pendingImages,
                threadId: streamInput.threadId,
                virtualMcpId: streamInput.agent.id,
                branch: streamInput.branch,
                htmlPageBuffer,
              });

              const vmMetadata = streamInput.virtualMcp.metadata as {
                instructions?: string;
              };
              const serverInstructions =
                typeof vmMetadata?.instructions === "string"
                  ? vmMetadata.instructions
                  : undefined;

              // Stash the passthrough tools for runDesktopEngine.
              engineClosure.passthroughTools = passthroughTools;

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
                    console.error(
                      "[decopilot-desktop] html-page flush failed",
                      err,
                    );
                  });
                },
                close: openedMcp.close,
              };
              return bundle;
            } catch (err) {
              // Construction failed mid-way — close the MCP client we already
              // opened so the session doesn't leak, then re-throw.
              await openedMcp.close().catch(() => {});
              cleanup.close = undefined;
              throw err;
            }
          },
          runEngine: async (args) =>
            runDesktopEngine(
              { input, passthroughTools: engineClosure.passthroughTools },
              args,
            ),
        };

        try {
          yield* runDecopilotCore({
            input,
            modelRuntime,
            toolRuntime,
            // Desktop runs stay OTel-invisible this phase (no monitoring sink).
            telemetry: undefined,
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

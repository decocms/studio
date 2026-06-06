/**
 * Desktop-harness factory for decopilot.
 *
 * Activates the main chat provider from the injected mcp.modelSecret,
 * builds the tool set with isDesktopContext: true (cluster-coupled built-ins
 * omitted — they are reached via mcp.url instead), and runs the same
 * runDecopilotStream loop.
 *
 * Studio-pack agent-prompt resolution is SKIPPED on the desktop. Studio-pack
 * agents (Brand Manager, etc.) are cluster-only; resolveDispatchTarget never
 * routes them to user-desktop. If one is accidentally sent, the harness runs
 * without the brand-specific prompt override (safe degradation).
 *
 * ⚠️ SECURITY NOTE: mcp.modelSecret carries the org's chat-completion API key
 * to the desktop. Scoped to the single main chat-completion key only.
 * Hardening: cluster model-proxy (spec §3.9) — deferred.
 */

import type {
  HarnessContext,
  Harness,
  HarnessFactory,
  HarnessStreamInput,
} from "../types";
import type { StudioContext } from "../../core/studio-context";
import type { MeshProvider } from "../../ai-providers/types";
import type { ChatMessage } from "../../api/routes/decopilot/types";
import type { ChatMode } from "../../api/routes/decopilot/mode-config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toolsFromMCP } from "../../api/routes/decopilot/helpers";
import { getBuiltInTools } from "./built-in-tools";
import { runDecopilotStream } from "./run-stream";
import { processConversation } from "../../api/routes/decopilot/conversation";
import { DEFAULT_WINDOW_SIZE } from "../../api/routes/decopilot/constants";
import {
  buildBasePlatformPrompt,
  buildDecopilotAgentPrompt,
  buildTodoWritePrompt,
} from "../../api/routes/decopilot/constants";
import { buildSystemMessages } from "./system-prompt";
import { buildConnectionsBlock } from "./connections-block";
import { isDecopilot } from "@decocms/mesh-sdk";
import type { AssembledTools } from "./tools";
import type { AssembledPrompt } from "./prompt";

/**
 * Returns true when the context is a narrow HarnessContext (desktop daemon),
 * false when it is a StudioContext (cluster in-process).
 *
 * The daemon constructs a HarnessContext directly (no storage/db); the cluster
 * passes its full StudioContext. The `storage` and `db` properties are reliable
 * discriminators because they are required fields on StudioContext but absent
 * from HarnessContext.
 */
export function isDesktopHarnessContext(ctx: HarnessContext): boolean {
  return !("storage" in ctx) && !("db" in ctx);
}

/** Narrowed view of the cluster's richer input fields for decopilot. */
interface DecopilotInputView {
  messages: ChatMessage[];
  mode: ChatMode;
  virtualMcp: { id: string; metadata?: unknown; [k: string]: unknown };
}

/**
 * Open an HTTP MCP client using the injected mcp.url + mcp.headers.
 * The caller is responsible for calling `client.close()`.
 */
async function openMcpClient(mcp: HarnessStreamInput["mcp"]): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
    requestInit: { headers: mcp.headers },
  });
  const client = new Client(
    { name: "decopilot-desktop", version: "1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

/**
 * Assemble a minimal system prompt for the desktop path.
 *
 * Unlike the cluster path, we skip `ctx.storage.virtualMcps.list()` (agents block
 * is empty — desktop agents don't have access to the org's agent list) and skip
 * studio-pack resolution (cluster-only). The connections block is still built from
 * the passthrough client's `connectionTitleMap` + `connectionsBlockTools`.
 */
async function assembleDesktopPrompt(
  input: HarnessStreamInput,
  tools: AssembledTools,
): Promise<AssembledPrompt> {
  const decopilotInput = input as HarnessStreamInput & DecopilotInputView;
  const basePrompt = buildBasePlatformPrompt();
  const connectionsBlock = buildConnectionsBlock(
    tools.connectionsBlockTools,
    tools.connectionTitleMap,
  );
  const agentPrompt = isDecopilot(input.agent.id)
    ? buildDecopilotAgentPrompt()
    : tools.serverInstructions;

  // On the desktop we skip:
  // - agentsBlock (requires ctx.storage.virtualMcps.list)
  // - promptsBlock (requires passthroughClient.listPrompts — we skip for simplicity)
  // - webSearchPrompt (web_search tool excluded on desktop)
  // - repoEnvironmentPrompt (same as cluster path if githubRepo is on the virtualMcp metadata)
  const systemPrompts = [
    basePrompt,
    connectionsBlock,
    buildTodoWritePrompt(),
    agentPrompt,
  ].filter((s): s is string => Boolean(s?.trim()));

  // Suppress unused-var warning: decopilotInput is kept for future use (e.g. repo prompt).
  void decopilotInput;

  return { systemMessages: buildSystemMessages(systemPrompts, new Date()) };
}

export const decopilotDesktopHarnessFactory: HarnessFactory = {
  id: "decopilot",
  create(harnessCtx: HarnessContext): Harness {
    // This factory is ONLY called from the daemon; the daemon constructs a
    // narrow HarnessContext. Defensive check for misuse.
    if (!isDesktopHarnessContext(harnessCtx)) {
      throw new Error(
        "decopilotDesktopHarnessFactory must only be used in the daemon context. " +
          "For cluster in-process, use decopilotHarnessFactory.",
      );
    }

    // Cast to StudioContext once — safe because with isDesktopContext: true,
    // all cluster-only code paths are excluded. The built-in tools that DO
    // execute (user_ask, todo_write, etc.) only touch optional ctx fields
    // that degrade safely when absent (ctx.objectStorage guarded by &&).
    // runDecopilotStream uses ctx.tracer, ctx.meter, and ctx.metadata — all
    // present on HarnessContext.
    const ctx = harnessCtx as unknown as StudioContext;

    return {
      id: "decopilot",
      async *stream(input: HarnessStreamInput) {
        const { mcp } = input;
        if (!mcp.modelSecret) {
          throw new Error(
            "Desktop decopilot requires mcp.modelSecret to be set. " +
              "The cluster must inject the chat-model credential when routing to user-desktop.",
          );
        }

        // Activate the chat provider from the injected secret.
        // harnessCtx.aiProviders is the daemon's adapter shim, which constructs
        // a MeshProvider using the ProviderAdapter matching modelSecret.providerId.
        const provider = harnessCtx.aiProviders
          ? ((await harnessCtx.aiProviders.activate(
              mcp.modelSecret.apiKey,
              input.organizationId,
            )) as MeshProvider | null)
          : null;

        if (!provider) {
          throw new Error(
            `Desktop decopilot: failed to activate provider '${mcp.modelSecret.providerId}'. ` +
              "Check that the ProviderAdapter for this provider is registered in the daemon.",
          );
        }

        // Open the HTTP MCP client to the cluster's virtual-mcp endpoint.
        const mcpClient = await openMcpClient(mcp);
        try {
          const toolOutputMap = new Map<string, string>();
          const pendingImages: import("./built-in-tools").PendingImage[] = [];

          // Build passthrough tools from the MCP endpoint.
          const { tools: passthroughTools, nameMap } = await toolsFromMCP(
            mcpClient,
            toolOutputMap,
            // No writer on desktop (no in-process UIMessageStreamWriter);
            // streaming tool output is handled by the runAgentLoop writer path.
            undefined,
            input.toolApprovalLevel,
          );

          // Collect passthrough tool list for connectionsBlock.
          const passthroughToolList = (await mcpClient.listTools()).tools;
          const connectionsBlockTools: import("./connections-block").ConnectionsBlockTool[] =
            [];
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
          }

          // Build the desktop built-in tools (isDesktopContext: true).
          // vmContext is null: no VM sandbox on the desktop daemon at this phase.
          const noopWriter: import("ai").UIMessageStreamWriter = {
            write: () => {},
            merge: async () => {},
            onError: () => {},
          };
          const builtInTools = await getBuiltInTools(
            // The writer is used only by cluster-coupled built-ins (excluded by
            // isDesktopContext: true) and by the no-op scrape/inspect tools.
            noopWriter,
            {
              provider,
              imageProvider: null,
              deepResearchProvider: null,
              // organization is not available on HarnessContext; pass a minimal shape.
              // Only used by the cluster-coupled tools which are excluded.
              organization: {
                id: input.organizationId,
              } as import("../../core/studio-context").OrganizationScope,
              models: input.models,
              toolApprovalLevel: input.toolApprovalLevel,
              isPlanMode: input.mode === "plan",
              toolOutputMap,
              pendingImages,
              passthroughClient:
                mcpClient as unknown as import("./built-in-tools/sandbox").VirtualClient,
              vmContext: null,
              // htmlPageBuffer: required by BuiltinToolParams but only used by
              // VM tools (excluded when vmContext is null). Provide a no-op shape.
              htmlPageBuffer: {
                enqueue: () => {},
                flush: async () => null,
              } as unknown as import("./built-in-tools/vm-tools/html-page-buffer").HtmlPageBuffer,
              taskId: input.taskId ?? input.threadId,
              agentId: input.agent.id,
              isDesktopContext: true,
            },
            ctx,
          );

          const tools: import("./tools").AssembledTools = {
            tools: { ...passthroughTools, ...builtInTools },
            nameMap,
            passthroughTools,
            builtInTools,
            passthroughToolList,
            connectionsBlockTools,
            toolAnnotations: new Map(),
            vmContext: null,
            // connectionTitleMap: not available without virtual-mcp passthrough client.
            // Use empty map — desktop connections block will be minimal.
            connectionTitleMap: new Map(),
            serverInstructions: undefined,
            passthroughClient:
              mcpClient as unknown as import("../../mcp-clients/virtual-mcp/passthrough-client").PassthroughClient,
            close: async () => {
              await mcpClient.close().catch(() => {});
            },
          };

          const decopilotInput = input as HarnessStreamInput &
            DecopilotInputView;

          try {
            const prompt = await assembleDesktopPrompt(input, tools);

            const {
              systemMessages: processedSystemMessages,
              messages: processedMessages,
              originalMessages,
            } = await processConversation(decopilotInput.messages, {
              windowSize: DEFAULT_WINDOW_SIZE,
              models: input.models,
              tools: tools.tools,
            });

            const narrowedMessages = processedMessages as Parameters<
              typeof runDecopilotStream
            >[4]["processedMessages"];

            const abortController = new AbortController();
            if (input.signal) {
              input.signal.addEventListener(
                "abort",
                () => abortController.abort(),
                {
                  once: true,
                },
              );
            }

            yield* runDecopilotStream(decopilotInput, ctx, tools, prompt, {
              provider,
              titleProvider: provider,
              titleModel: input.models.fast ?? input.models.thinking,
              registrySignal: abortController.signal,
              // runRegistry is cluster-only; pass a minimal no-op sentinel.
              // The deferred-FINISH recovery path only fires for registered runs.
              runRegistry:
                null as unknown as import("../../api/routes/decopilot/run-registry").RunRegistry,
              processedSystemMessages,
              processedMessages: narrowedMessages,
              originalMessages,
              threadId: input.threadId,
              currentThreadTitle: input.currentThreadTitle ?? "",
              registerPendingOp: () => {},
              isStreamFinished: () => false,
              onUsageAggregated: () => {},
              pendingImages,
              // writer: used by runAgentLoop for streaming tool metadata.
              // Pass the same no-op writer; the desktop stream is yielded directly.
              writer: noopWriter,
            });
          } finally {
            await tools.close();
          }
        } finally {
          await mcpClient.close().catch(() => {});
        }
      },
    };
  },
};

/**
 * decopilot-desktop harness — the import-isolated native decopilot runtime that
 * runs INSIDE the desktop daemon (`packages/sandbox/daemon`).
 *
 * Registered in the daemon's `dispatchHarnessRegistry` under the id "decopilot".
 * Unlike the cluster `decopilotHarnessFactory` (which threads the full
 * `StudioContext`, vault, storage, and run-registry), this factory:
 *   - activates the chat provider from the injected `mcp.modelSecret`
 *     (`provider-from-secret`) instead of `ctx.aiProviders.activate` + vault;
 *   - opens an HTTP MCP `Client` to `mcp.url` and exposes its tools as
 *     passthrough tools (`toolsFromMCP`);
 *   - assembles only the LOCAL-OK built-ins (`buildLocalTools`) — the 5 cluster
 *     built-ins are reached through `mcp.url` as passthrough tools;
 *   - runs a lean `streamText` loop (`runDesktopAgentLoop`) with no monitoring
 *     / run-registry coupling.
 *
 * It imports ONLY portable leaves (relative paths) + `../types`. No `@/*`
 * specifier and no `StudioContext` ever enters this graph, so the daemon bundles
 * it and `tsc` does not overflow.
 *
 * ⚠️ SECURITY: `mcp.modelSecret` carries an org chat-completion API key in
 * plaintext over HTTPS. Never log it. Hardening (cluster model-proxy, spec §3.9)
 * is deferred.
 */

import type { UIMessageChunk } from "ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isDecopilot } from "@decocms/mesh-sdk";
import type {
  Harness,
  HarnessContext,
  HarnessFactory,
  HarnessStreamInput,
} from "../types";
import { createProviderFromSecret } from "./provider-from-secret";
import { toolsFromMCP } from "./local-helpers";
import { buildLocalTools } from "./local-tools";
import { processConversation } from "./local-conversation";
import { runDesktopAgentLoop } from "./local-agent-loop";
import { DEFAULT_WINDOW_SIZE } from "./local-prompt";
import type { ConnectionsBlockTool } from "../decopilot/connections-block";
import type { VirtualClient } from "../decopilot/built-in-tools/sandbox";
import type { DesktopToolCtx } from "./types";

/** Open an HTTP MCP client to the cluster's virtual-mcp endpoint. The caller
 *  must `client.close()`. */
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

export const decopilotDesktopHarnessFactory: HarnessFactory = {
  id: "decopilot",
  create(_ctx: HarnessContext): Harness {
    return {
      id: "decopilot",
      async *stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
        const { mcp } = input;
        if (!mcp.modelSecret) {
          throw new Error(
            "decopilot-desktop requires mcp.modelSecret. The cluster must inject " +
              "the chat-model credential when routing decopilot to user-desktop.",
          );
        }

        // 1. Activate the chat provider locally from the injected secret. Never
        //    log mcp.modelSecret — it carries a provider API key.
        const provider = createProviderFromSecret(mcp.modelSecret);

        // Diagnostics (provider id only, never the key). On the desktop this
        // runs inside the spawned daemon, so it surfaces in the link terminal.
        console.log(
          `[decopilot-desktop] stream start provider=${mcp.modelSecret.providerId} ` +
            `model=${input.models.thinking.id} mcpUrl=${mcp.url} mode=${input.mode}`,
        );

        // 2. Open the MCP client to the cluster's virtual-mcp endpoint.
        const mcpClient = await openMcpClient(mcp);
        try {
          const toolOutputMap = new Map<string, string>();

          // 3. Build passthrough tools from the MCP endpoint.
          const { tools: passthroughTools, nameMap } = await toolsFromMCP(
            mcpClient,
            toolOutputMap,
            undefined,
            input.toolApprovalLevel,
            { isPlanMode: input.mode === "plan" },
          );

          // 4. Collect the connections-block list + read-only annotations from
          //    the raw tool listing (drives enable_tool + the connections
          //    prompt block + plan-mode gating).
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

          // 5. Build the LOCAL-OK built-in tools.
          const ctx: DesktopToolCtx = {
            objectStorage: null,
            organization: { id: input.organizationId },
            auth: { user: { id: input.user.id } },
          };
          const localTools = buildLocalTools({
            // No in-process UIMessageStreamWriter on the desktop — tool latency
            // metadata is best-effort via this no-op writer.
            writer: {
              write: () => {},
              merge: async () => {},
              onError: () => {},
            },
            toolOutputMap,
            passthroughClient: mcpClient as unknown as VirtualClient,
            toolApprovalLevel: input.toolApprovalLevel,
            isPlanMode: input.mode === "plan",
            ctx,
          });

          // 6. Process the conversation with the REAL tool set so prior-turn
          //    tool outputs (truncation `toModelOutput`) transform correctly.
          const allTools = { ...passthroughTools, ...localTools };
          const {
            systemMessages: processedSystemMessages,
            messages: processedMessages,
            originalMessages,
          } = await processConversation(input.messages, {
            windowSize: DEFAULT_WINDOW_SIZE,
            models: input.models,
            tools: allTools,
          });

          const narrowedMessages = processedMessages as Parameters<
            typeof runDesktopAgentLoop
          >[0]["processedMessages"];

          // 7. Run the lean agent loop.
          yield* runDesktopAgentLoop({
            provider,
            models: input.models,
            mode: input.mode,
            temperature: input.temperature,
            isDecopilotAgent: isDecopilot(input.agent.id) !== null,
            agentId: input.agent.id,
            agentInstructions:
              typeof (input.virtualMcp.metadata as { instructions?: string })
                ?.instructions === "string"
                ? (input.virtualMcp.metadata as { instructions?: string })
                    .instructions
                : undefined,
            processedMessages: narrowedMessages,
            processedSystemMessages,
            originalMessages: originalMessages as Array<{
              role: string;
              parts: ReadonlyArray<unknown>;
            }>,
            passthroughTools,
            localTools,
            connectionsBlockTools,
            connectionTitleMap: new Map(),
            toolAnnotations,
            abortSignal: input.signal,
            threadId: input.threadId,
            currentThreadTitle: input.currentThreadTitle ?? "",
            agentIdForMetadata: input.agent.id,
          });
        } finally {
          await mcpClient.close().catch(() => {});
        }
      },
    };
  },
};

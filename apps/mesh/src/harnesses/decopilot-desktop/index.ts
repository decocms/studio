/**
 * decopilot-desktop harness — the import-isolated native decopilot runtime that
 * runs INSIDE the desktop daemon (`packages/sandbox/daemon`).
 *
 * Registered in the daemon's `dispatchHarnessRegistry` under the id "decopilot".
 * Unlike the cluster `decopilotHarnessFactory` (which threads the full
 * `StudioContext`, vault, storage, and run-registry), this factory:
 *   - activates the chat provider from the injected `modelSource`
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
 * ⚠️ SECURITY: `modelSource(kind="secret")` carries an org chat-completion API key in
 * plaintext over HTTPS. Never log it. Hardening (cluster model-proxy, spec §3.9)
 * is deferred.
 */

import type { UIMessageChunk, UIMessageStreamWriter } from "ai";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isDecopilot } from "@decocms/mesh-sdk";
import type {
  DecopilotHttpMcpSource,
  DecopilotSecretModelSource,
  Harness,
  HarnessContext,
  HarnessFactory,
  HarnessStreamInput,
} from "../types";
import { openMcpSource } from "../sources";
import { createProviderFromSecret } from "../decopilot/provider-from-secret";
import { toolsFromMCP } from "../decopilot/mcp-tools";
import { buildLocalTools } from "./local-tools";
import { processConversation } from "../decopilot/conversation";
import { runDesktopAgentLoop } from "./local-agent-loop";
import { DEFAULT_WINDOW_SIZE } from "./local-prompt";
import { createRemoteObjectStorage } from "./object-storage";
import type { ConnectionsBlockTool } from "../decopilot/connections-block";
import type { VirtualClient } from "../decopilot/built-in-tools/sandbox";
import type { PendingImage } from "../decopilot/built-in-tools/vm-tools/types";
import type { DesktopToolCtx } from "./types";
import { createHtmlPageBufferFromStorage } from "../decopilot/built-in-tools/vm-tools/html-page-buffer-core";

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

function createSideChannelWriter(): {
  writer: UIMessageStreamWriter;
  stream: AsyncIterable<UIMessageChunk>;
  close: () => void;
} {
  const queue: UIMessageChunk[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const current = wake;
    wake = null;
    current?.();
  };
  const push = (chunk: UIMessageChunk) => {
    if (closed) return;
    queue.push(chunk);
    notify();
  };
  const stream = (async function* () {
    try {
      while (!closed || queue.length > 0) {
        const chunk = queue.shift();
        if (chunk) {
          yield chunk;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      closed = true;
      notify();
    }
  })();

  return {
    writer: {
      write: (chunk) => push(chunk as UIMessageChunk),
      merge: async (source) => {
        const maybeIterable =
          source as unknown as AsyncIterable<UIMessageChunk>;
        if (typeof maybeIterable[Symbol.asyncIterator] === "function") {
          for await (const chunk of maybeIterable) {
            push(chunk);
          }
          return;
        }
        const reader = (source as ReadableStream<UIMessageChunk>).getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) return;
            push(value);
          }
        } finally {
          reader.releaseLock();
        }
      },
      onError: () => {},
    } as UIMessageStreamWriter,
    stream,
    close: () => {
      closed = true;
      notify();
    },
  };
}

export function resolveDesktopRuntimeSources(input: HarnessStreamInput): {
  modelSource: DecopilotSecretModelSource;
  mcpSource: DecopilotHttpMcpSource;
} {
  const modelSource =
    input.modelSources?.primary?.kind === "secret"
      ? input.modelSources.primary
      : input.modelSource?.kind === "secret"
        ? input.modelSource
        : null;
  if (!modelSource) {
    throw new Error(
      "decopilot-desktop requires a secret modelSource. The cluster must inject " +
        "the chat-model credential when routing decopilot to user-desktop.",
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

export const decopilotDesktopHarnessFactory: HarnessFactory = {
  id: "decopilot",
  create(_ctx: HarnessContext): Harness {
    return {
      id: "decopilot",
      async *stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
        const { mcp } = input;
        const { modelSource, mcpSource } = resolveDesktopRuntimeSources(input);

        // 1. Activate the chat provider locally from the injected secret. Never
        //    log modelSource — it carries a provider API key.
        const provider = createProviderFromSecret(modelSource);

        // Diagnostics (provider id only, never the key). On the desktop this
        // runs inside the spawned daemon, so it surfaces in the link terminal.
        console.log(
          `[decopilot-desktop] stream start provider=${modelSource.providerId} ` +
            `model=${input.models.thinking.id} mcpUrl=${mcp.url} mode=${input.mode}`,
        );

        // 2. Open the MCP client to the cluster's virtual-mcp endpoint.
        const openedMcp = await openMcpSource(mcpSource, {
          clientInfo: { name: "decopilot-desktop", version: "1" },
        });
        const mcpClient = openedMcp.client as Client;
        try {
          const toolOutputMap = new Map<string, string>();
          const pendingImages: PendingImage[] = [];
          const sideChannel = createSideChannelWriter();

          // 3. Build passthrough tools from the MCP endpoint.
          const { tools: passthroughTools, nameMap } = await toolsFromMCP(
            mcpClient,
            toolOutputMap,
            undefined,
            input.toolApprovalLevel,
            {
              isPlanMode: input.mode === "plan",
              isToolVisible: isDesktopToolVisible,
            },
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
          const objectStorage =
            input.objectStorageSource?.kind === "http"
              ? createRemoteObjectStorage({
                  baseUrl: input.objectStorageSource.baseUrl,
                  headers: input.objectStorageSource.headers,
                })
              : null;
          const orgSlug = input.organizationSlug ?? input.projectSlug;
          const baseUrl = input.objectStorageSource
            ? new URL(input.objectStorageSource.baseUrl).origin
            : "";
          const htmlPageBuffer = createHtmlPageBufferFromStorage({
            storage: objectStorage,
            baseUrl,
            orgSlug,
            writer: sideChannel.writer,
            logPrefix: "decopilot-desktop:html-page-buffer",
          });
          const ctx: DesktopToolCtx = {
            objectStorage,
            organization: { id: input.organizationId, slug: orgSlug },
            auth: { user: { id: input.user.id } },
            baseUrl,
          };
          const localTools = buildLocalTools({
            writer: sideChannel.writer,
            toolOutputMap,
            passthroughClient: mcpClient as unknown as VirtualClient,
            toolApprovalLevel: input.toolApprovalLevel,
            isPlanMode: input.mode === "plan",
            ctx,
            // subtask runs cluster-side via the SUBTASK_MCP relay. The wrapper
            // injects these so the model never supplies credential/model ids,
            // and defaults the target to this agent (omit agent_id → clone self).
            mcpClient,
            models: input.models,
            selfAgentId: input.agent.id,
            pendingImages,
            threadId: input.threadId,
            virtualMcpId: input.agent.id,
            branch: input.branch,
            htmlPageBuffer,
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
          try {
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
              pendingImages,
              abortSignal: input.signal,
              threadId: input.threadId,
              currentThreadTitle: input.currentThreadTitle ?? "",
              agentIdForMetadata: input.agent.id,
              onStepFinish: async () => {
                await htmlPageBuffer.flush().catch((err) => {
                  console.error(
                    "[decopilot-desktop] html-page flush failed",
                    err,
                  );
                });
              },
              sideChunks: sideChannel.stream,
            });
          } finally {
            sideChannel.close();
          }
        } finally {
          await openedMcp.close();
        }
      },
    };
  },
};

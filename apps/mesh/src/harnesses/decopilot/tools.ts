/**
 * assembleDecopilotTools
 *
 * Builds the tool set the decopilot harness exposes to `streamText`. Owns:
 *  - Passthrough MCP client construction (over the loaded Virtual MCP).
 *  - Conversion of MCP tools into AI-SDK `ToolSet` via `toolsFromMCP`.
 *  - Built-in platform tools via `getBuiltInTools` (subtask, user_ask, vm
 *    file tools, sandbox, web_search, etc.).
 *  - Single `listTools()` round-trip to derive (a) connections-block
 *    entries, (b) connection ids for `enable_tool` short-name resolution,
 *    and (c) per-tool annotations used for plan-mode gating.
 *  - VM file-tool binding context (`vmContext`) keyed on whether the
 *    agent is GitHub-linked or ephemeral.
 *
 * Today this code lives inline inside `stream-core.ts` (~lines 530–660);
 * the helper here is unused until Task 12 wires it through the harness
 * factory. Behavior is intended to be byte-for-byte the same as the
 * inline version, modulo the CLI-agent branch (claude-code / codex)
 * which is removed because the decopilot harness never runs against
 * those providers — they have their own harnesses.
 */

import type { ToolSet, UIMessageStreamWriter } from "ai";
import type { GithubRepo } from "@decocms/mesh-sdk";
import type { MeshContext } from "@/core/mesh-context";
import { createVirtualClientFrom } from "@/mcp-clients/virtual-mcp";
import type { PassthroughClient } from "@/mcp-clients/virtual-mcp/passthrough-client";
import type { MeshProvider } from "@/ai-providers/types";
import {
  getBuiltInTools,
  type PendingImage,
  type VmContext,
} from "./built-in-tools";
import type { HtmlPageBuffer } from "./built-in-tools/vm-tools/html-page-buffer";
import type { ConnectionsBlockTool } from "./connections-block";
import { toolsFromMCP } from "../../api/routes/decopilot/helpers";
import type { HarnessStreamInput } from "../types";

/** Raw MCP tool entries returned by `passthroughClient.listTools()`. */
export type PassthroughToolList = Awaited<
  ReturnType<PassthroughClient["listTools"]>
>["tools"];

export interface AssembledTools {
  /** Combined tool set: passthrough MCP tools + built-in platform tools.
   *  `enable_tool` is NOT included here — it depends on `enabledTools`
   *  state which is reconstructed from message history at call time, so
   *  the caller (runDecopilotStream) attaches it. */
  tools: ToolSet;
  /** Maps raw MCP tool name → safe (model-facing) tool name. */
  nameMap: Map<string, string>;
  /** Subset of the toolset that came from the passthrough MCP — used by
   *  `enable_tool` to enumerate the set of activatable tools. */
  passthroughTools: ToolSet;
  /** Just the platform built-in tools — currently unused outside this
   *  helper, but exposed so the caller can introspect (e.g. for
   *  `propose_plan` presence). */
  builtInTools: Awaited<ReturnType<typeof getBuiltInTools>>;
  /** Raw passthrough tool list — kept around for connection-block /
   *  enable-tool flow construction in the caller. */
  passthroughToolList: PassthroughToolList;
  /** ConnectionsBlockTool entries derived from `listTools()` — consumed
   *  by `buildConnectionsBlock` in the prompt-assembly step. */
  connectionsBlockTools: ConnectionsBlockTool[];
  /** Connection ids known to the agent; used by `createEnableToolTool`
   *  to resolve short tool names against connection prefixes. */
  connectionIds: Set<string>;
  /** Per-tool annotations (only populated in plan mode) — used to gate
   *  read-only vs write tools during enable_tool. */
  toolAnnotations: Map<string, { readOnlyHint?: boolean }>;
  /** VM file-tool binding context. `null` when no userId is present. */
  vmContext: VmContext | null;
  /** Connection id → human title — consumed by `buildConnectionsBlock`. */
  connectionTitleMap: Map<string, string>;
  /** Server-provided instructions from the Virtual MCP — used as the
   *  agent prompt for non-decopilot agents. */
  serverInstructions: string | undefined;
  /** The live passthrough client. The caller is responsible for closing
   *  it (via `.close()`) on abort / completion. Kept on the result so
   *  the caller can also call `listPrompts()` for the prompts block. */
  passthroughClient: PassthroughClient;
  /** Convenience cleanup — calls `passthroughClient.close()` and
   *  swallows errors, matching today's inline behavior. */
  close: () => Promise<void>;
}

/** Per-request extras that don't live in `HarnessStreamInput`. These are
 *  produced inside the `createUIMessageStream` execute callback (writer)
 *  or by the surrounding stream-core scope (toolOutputMap, pendingImages,
 *  threadId from the loaded memory). */
export interface AssembleDecopilotToolsExtras {
  writer: UIMessageStreamWriter;
  toolOutputMap: Map<string, string>;
  pendingImages: PendingImage[];
  /** From the loaded memory; used by `vmContext.threadId` to scope
   *  artifacts under `model-outputs/<threadId>/`. Equivalent to
   *  `mem.thread.id` in today's inline code. */
  threadId: string;
  /** Provider used to instantiate built-in tools that need a model
   *  (subtask, generate_image, web_search). The decopilot harness
   *  activates this in advance — `null` is rejected by `getBuiltInTools`
   *  for tools that require it, but we forward whatever the caller has. */
  provider: MeshProvider | null;
  /** Per-turn HTML-page coalescing buffer. Created in dispatch-run.ts
   *  alongside `pendingOps` so the dispatch layer can also schedule a
   *  flush at step-end. */
  htmlPageBuffer: HtmlPageBuffer;
}

/**
 * Build the decopilot tool set for one streamText turn.
 *
 * Two side-effects:
 *  1. Opens a passthrough MCP client (caller must close it via
 *     `result.close()` or `result.passthroughClient.close()`).
 *  2. Issues one `listTools()` call — its result is exposed via
 *     `passthroughToolList` so the caller doesn't need a second
 *     round-trip when building the connections block / enable_tool
 *     short-name index.
 */
export async function assembleDecopilotTools(
  input: HarnessStreamInput,
  ctx: MeshContext,
  extras: AssembleDecopilotToolsExtras,
): Promise<AssembledTools> {
  const organization = ctx.organization!;
  const isPlanMode = input.mode === "plan";

  // superUser=true: the user is already authenticated as an org member,
  // the virtual MCP enforces which connections are in scope, and the
  // per-tool AuthTransport check would block every non-public connection
  // tool (GitHub, Slack, etc.) for users who don't have explicit per-tool
  // permissions configured — the wrong enforcement layer for chat.
  const passthroughClient = await createVirtualClientFrom(
    // Cluster-side: `virtualMcp` is the real `VirtualMCPEntity`; the
    // package widens the field to a loose bag so the daemon can ship
    // without the cluster's storage types. Narrow back here.
    input.virtualMcp as Parameters<typeof createVirtualClientFrom>[0],
    ctx,
    "passthrough",
    true,
    { listTimeoutMs: 1_000 },
  );

  // Once the passthrough client is open, every subsequent failure in
  // tool assembly (toolsFromMCP, getBuiltInTools, listTools, …) MUST
  // close it before propagating the error — otherwise the client (which
  // owns an MCP session, file handles, possibly a websocket) leaks. The
  // inline original in stream-core handled this via a `closeClients`
  // hook attached before the calls; the harness factory's outer
  // try/finally only covers post-construction errors, so the cleanup
  // belongs inside the helper.
  try {
    const { tools: passthroughTools, nameMap: passthroughNameMap } =
      await toolsFromMCP(
        passthroughClient,
        extras.toolOutputMap,
        extras.writer,
        input.toolApprovalLevel,
        { ctx, isPlanMode },
      );

    // VM file tools bind to (virtualMcpId, branch, userId). The VM is
    // provisioned lazily on the first tool call inside getBuiltInTools.
    //
    // Two keying regimes:
    // - GitHub-linked agents (githubRepo set) need per-branch isolation
    //   so PR/branch workflows don't trample each other. Falls back to a
    //   `thread:<taskId>` synthetic branch when no explicit branch is
    //   supplied yet.
    // - Ephemeral agents (no githubRepo) share one VM per (user, agent)
    //   across threads. The skills work is mostly read-heavy and
    //   sharing a sandbox cuts the VM count linearly with thread count.
    //   Tradeoff: concurrent threads share /app, /home/sandbox, /tmp —
    //   parallel writes to overlapping filenames can race. Fine for
    //   reads and scoped outputs; revisit if it bites.
    const vmMetadata = input.virtualMcp.metadata as {
      githubRepo?: GithubRepo | null;
    };
    const isEphemeralAgent = !vmMetadata.githubRepo;
    const vmContext: VmContext | null = input.user.id
      ? {
          virtualMcpId: input.agent.id,
          branch: isEphemeralAgent
            ? "ephemeral"
            : (input.branch ?? `thread:${extras.threadId}`),
          userId: input.user.id,
          // Used by share_with_user to scope artifacts under
          // model-outputs/<threadId>/. Cannot be derived from the
          // sandbox row since one ephemeral sandbox serves many threads.
          threadId: extras.threadId,
        }
      : null;

    const builtInTools = await getBuiltInTools(
      extras.writer,
      {
        provider: extras.provider,
        organization,
        models: input.models,
        toolApprovalLevel: input.toolApprovalLevel,
        isPlanMode,
        toolOutputMap: extras.toolOutputMap,
        pendingImages: extras.pendingImages,
        passthroughClient,
        vmContext,
        htmlPageBuffer: extras.htmlPageBuffer,
        taskId: extras.threadId,
      },
      ctx,
    );

    // Collect (rawName, safeName, connectionId) triples for the
    // connections block, the set of connection ids for enable_tool
    // short-name resolution, and the per-tool annotations used for
    // plan-mode gating — all from a single listTools() round-trip.
    const passthroughToolList = (await passthroughClient.listTools()).tools;
    const connectionsBlockTools: ConnectionsBlockTool[] = [];
    const connectionIds = new Set<string>();
    const toolAnnotations = new Map<string, { readOnlyHint?: boolean }>();
    for (const t of passthroughToolList) {
      const safeName = passthroughNameMap.get(t.name);
      if (!safeName) continue;
      // _meta.gatewayClientId is set by the gateway when the tool is
      // proxied from a non-virtual connection; the "unknown" fallback
      // only fires for tools that didn't traverse the gateway, which
      // currently means none in the passthrough flow — it's defense
      // in depth rather than a real case.
      const connectionId =
        typeof t._meta?.gatewayClientId === "string"
          ? t._meta.gatewayClientId
          : "unknown";
      connectionsBlockTools.push({
        rawName: t.name,
        safeName,
        connectionId,
      });
      connectionIds.add(connectionId);
      if (isPlanMode) {
        toolAnnotations.set(safeName, {
          readOnlyHint: t.annotations?.readOnlyHint,
        });
      }
    }

    const connectionTitleMap = passthroughClient.getConnectionTitleMap();
    const serverInstructions = passthroughClient.getInstructions();

    // Anthropic prompt-cache invariant: the cache key for our system
    // block markers is hash(tools + system_prefix), so the serialized
    // `tools` JSON must be byte-stable across calls that should hit the
    // cache. We rely on object-spread insertion order being deterministic
    // here. `withCachedToolPrefix` (which sorts + marks) is intentionally
    // NOT applied because `enable_tool` mutates the toolset across
    // subsequent LLM calls in the same turn — any tool-prefix marker
    // would invalidate on the next call anyway.
    //
    // `enable_tool` itself is NOT attached here — the caller assembles
    // it after reconstructing `enabledTools` from message history.
    const tools: ToolSet = {
      ...passthroughTools,
      ...builtInTools,
    };

    return {
      tools,
      nameMap: passthroughNameMap,
      passthroughTools,
      builtInTools,
      passthroughToolList,
      connectionsBlockTools,
      connectionIds,
      toolAnnotations,
      vmContext,
      connectionTitleMap,
      serverInstructions,
      passthroughClient,
      close: async () => {
        await passthroughClient.close().catch(() => {});
      },
    };
  } catch (err) {
    // Construction failed mid-way. Close the passthrough client we
    // already opened so the MCP session doesn't leak, then re-throw so
    // the caller's error path can run unchanged.
    await passthroughClient.close().catch(() => {});
    throw err;
  }
}

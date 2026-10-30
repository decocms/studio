/**
 * assembleDecopilotTools
 *
 * Builds the tool set the decopilot harness exposes to `streamText`. Owns:
 *  - Passthrough MCP client construction (over the loaded Virtual MCP).
 *  - Conversion of MCP tools into AI-SDK `ToolSet` via `toolsFromMCP`.
 *  - Built-in platform tools via `getBuiltInTools` (subtask, user_ask, vm
 *    file tools, sandbox, web_search, etc.).
 *  - Single `listTools()` round-trip to derive (a) connections-block
 *    entries and (b) per-tool annotations used for plan-mode gating.
 *  - VM file-tool binding context (`vmContext`) keyed on whether the
 *    agent is GitHub-linked or ephemeral.
 */

import type { ToolSet, UIMessageStreamWriter } from "ai";
import type { RepositoryBinding } from "@decocms/shared/sdk";
import type { StudioContext } from "@/core/studio-context";
import type { VirtualMCPEntity } from "@/tools/virtual/schema";
import type { ConnectionEntity } from "@/tools/connection/schema";
import { createVirtualClientFrom } from "@/mcp-clients/virtual-mcp";
import { resolveDevConnection } from "@/api/routes/dev-connection";
import { readSandboxMap } from "@/tools/sandbox/sandbox-map";
import { buildClusterMcpToolHooks } from "@/api/routes/decopilot/cluster-mcp-tool-hooks";
import {
  getThreadRepository,
  getThreadPinnedRef,
  resolveSandboxBranch,
} from "@/tools/sandbox/thread-repo";
import type { PassthroughClient } from "@/mcp-clients/virtual-mcp/passthrough-client";
import type { StudioProvider } from "@/ai-providers/types";
import type { BackgroundDispatcher } from "@/harnesses/lib/decopilot/built-in-tools/backgroundable";
import {
  getBuiltInTools,
  type PendingImage,
  type VmContext,
} from "./built-in-tools";
import type { HtmlArtifactBuffer } from "@/harnesses/lib/decopilot/built-in-tools/vm-tools/types";
import type { ConnectionsBlockTool } from "@/harnesses/lib/decopilot/connections-block";
import { agentSandboxEnabled } from "@/settings";
import { sandboxOnlyChatsEnabled } from "@/harnesses/sandbox-only-chats";
import { toolsFromMCP } from "@/harnesses/lib/decopilot/mcp-tools";
import { MCP_LIST_TIMEOUT_MS } from "@/core/constants";
import { MCP_TOOL_CALL_TIMEOUT_MS } from "@/harnesses/lib/decopilot/harness-constants";
import {
  filterBuiltInsByAllowlist,
  filterPassthroughByAllowlist,
} from "./tool-allowlist";
import { requireDecopilotRunContext } from "@/harnesses/lib/decopilot/run-context";
import type { HarnessStreamInput } from "@/harnesses/lib/types";

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
  /** From the loaded memory; used to scope sandbox filesystem calls and
   *  thread-owned artifacts. Equivalent to `mem.thread.id` in today's
   *  inline code. */
  threadId: string;
  /** Provider used to instantiate built-in tools that need a model
   *  (subtask, generate_image, web_search). The decopilot harness
   *  activates this in advance — `null` is rejected by `getBuiltInTools`
   *  for tools that require it, but we forward whatever the caller has. */
  provider: StudioProvider | null;
  /** Provider for `generate_image`. Caller passes the chat provider when
   *  the org's `image` tier shares the chat credential. */
  imageProvider: StudioProvider | null;
  /** Provider for the quick `web_search` tool. Caller passes the chat
   *  provider when the org's `web_search` tier shares the chat credential. */
  webSearchProvider: StudioProvider | null;
  /** Provider for the `deep_research` tool's async/deep path. Caller passes
   *  the chat provider when the org's `deep_research` tier shares the chat
   *  credential. */
  deepResearchProvider: StudioProvider | null;
  /** Per-turn HTML-artifact fast-path mirror (`/app/org/home/{decks,pages}/
   *  *.html`) — flushed into org-fs at step-end by the dispatch layer. */
  htmlArtifactBuffer?: HtmlArtifactBuffer;
  /** Usage roll-up sink (Task 17) — forwarded to the `subtask` built-in so a
   *  delegated child run's tokens fold into the parent run's accumulator. */
  onChildUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }) => void;
  /** Cluster-injected: makes slow built-ins (generate_image) run as durable
   *  background jobs instead of holding the turn open. */
  backgroundDispatcher?: BackgroundDispatcher | null;
}

/**
 * Build the decopilot tool set for one streamText turn.
 *
 * Two side-effects:
 *  1. Opens a passthrough MCP client (caller must close it via
 *     `result.close()` or `result.passthroughClient.close()`).
 *  2. Issues one `listTools()` call — its result is exposed via
 *     `passthroughToolList` so the caller doesn't need a second
 *     round-trip when building the connections block.
 */
export async function assembleDecopilotTools(
  input: HarnessStreamInput,
  ctx: StudioContext,
  extras: AssembleDecopilotToolsExtras,
): Promise<AssembledTools> {
  const runContext = requireDecopilotRunContext(input);
  const organization = ctx.organization!;
  const isPlanMode = input.mode === "plan";
  // Per-run tool allowlist (model-facing names). Empty array is treated as
  // "no restriction" so a misconfigured automation never ends up tool-less.
  const allowlist =
    input.toolAllowlist && input.toolAllowlist.length > 0
      ? new Set(input.toolAllowlist)
      : null;

  const virtualMcp = runContext.virtualMcp as VirtualMCPEntity;
  // Include the running sandbox's dev tools only after confirming it speaks MCP.
  let devConnection: ConnectionEntity | null = null;
  if (
    virtualMcp.id &&
    input.user.id &&
    readSandboxMap(virtualMcp.metadata)[input.user.id]
  ) {
    devConnection = await resolveDevConnection(
      ctx,
      virtualMcp.id,
      input.user.id,
      runContext.branch ?? undefined,
    ).catch(() => null);
  }
  // superUser=true: the user is already authenticated as an org member,
  // the virtual MCP enforces which connections are in scope, and the
  // per-tool AuthTransport check would block every non-public connection
  // tool (GitHub, Slack, etc.) for users who don't have explicit per-tool
  // permissions configured — the wrong enforcement layer for chat.
  // `listTimeoutMs` reached the aggregator for the first time when the fan-out
  // was bounded; until then it was an inert option and this 1s never applied.
  // 1s is below a cache-cold MCP handshake, so honouring it literally would
  // start dropping working connections out of a chat's toolset. The shared
  // budget keeps the intent (no connection may stall run start) at a value a
  // healthy connection actually meets.
  const passthroughClient = await createVirtualClientFrom(
    virtualMcp,
    ctx,
    true,
    {
      listTimeoutMs: MCP_LIST_TIMEOUT_MS,
      includeSkillsCatalog: true,
      additionalConnections: devConnection ? [devConnection] : [],
    },
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
    const {
      tools: rawPassthroughTools,
      nameMap: passthroughNameMap,
      rawTools: passthroughToolList,
    } = await toolsFromMCP(
      passthroughClient,
      extras.toolOutputMap,
      extras.writer,
      input.toolApprovalLevel,
      {
        isPlanMode,
        timeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
        ...buildClusterMcpToolHooks(ctx, extras.threadId),
      },
    );
    // Restrict to the allowlist (if any) so enable_tool enumeration, the
    // connections block, and the model-facing toolset all agree.
    const passthroughTools = filterPassthroughByAllowlist(
      rawPassthroughTools,
      passthroughNameMap,
      allowlist,
    );

    // VM file tools bind to (virtualMcpId, branch, userId). The VM is
    // provisioned lazily on the first tool call inside getBuiltInTools.
    //
    // Two keying regimes:
    // - repository-linked agents (repository set) need per-branch isolation
    //   so PR/branch workflows don't trample each other. Falls back to a
    //   `thread:<taskId>` synthetic branch when no explicit branch is
    //   supplied yet.
    // - Ephemeral agents (no repository) share one VM per (user, agent)
    //   across threads. The skills work is mostly read-heavy and
    //   sharing a sandbox cuts the VM count linearly with thread count.
    //   Tradeoff: concurrent threads share /app, /home/sandbox, /tmp —
    //   parallel writes to overlapping filenames can race. Fine for
    //   reads and scoped outputs; revisit if it bites.
    const vmMetadata = runContext.virtualMcp.metadata as {
      repository?: RepositoryBinding | null;
    };
    // A thread-scoped repo (set by `load_repo`, super-agent-only) wins: it's the
    // only place a repo can persist for the synthetic Decopilot agent. Threads of
    // real repo-agents never carry one. When present it pins the thread to a
    // dedicated `thread:<id>` sandbox branch (not the shared "ephemeral" one).
    const threadRepo = await getThreadRepository(ctx, extras.threadId);
    // Must be read here too, not just in `resolveSandboxBranchForThread`: this
    // derivation and the dispatch path's have to agree exactly, and a pin seen
    // by only one of them would provision a second pod for the same thread.
    const pinnedRef = await getThreadPinnedRef(ctx, extras.threadId);
    // Without the hosted sandbox, building the file tools throws.
    const vmEnabled = Boolean(input.user.id) && agentSandboxEnabled();
    const sandboxOnlyChats =
      vmEnabled && (await sandboxOnlyChatsEnabled(ctx, organization.id));
    const vmContext: VmContext | null = vmEnabled
      ? {
          virtualMcpId: input.agent.id,
          // Shared with the sandbox-hosted dispatch path — see
          // `resolveSandboxBranch`. Two derivations that drift provision two
          // pods for one thread.
          branch: resolveSandboxBranch({
            threadId: extras.threadId,
            threadRepo,
            agentRepo: vmMetadata.repository,
            runBranch: runContext.branch,
            pinnedRef,
            sandboxOnlyChats,
          }),
          userId: input.user.id,
          // Scopes /app/org/output and thread-owned artifacts. Cannot be derived
          // from the sandbox row since one ephemeral sandbox serves many
          // threads.
          threadId: extras.threadId,
          // Lets the fs layer mint an endpoint and materialize the tool
          // catalog into the sandbox once it's provisioned (hosted runs
          // never send a /dispatch envelope, so the daemon can't do it
          // itself; `input.mcp` is decopilot's in-process sentinel with an
          // empty url — never forward it).
          syncTools: true,
        }
      : null;

    const allBuiltInTools = await getBuiltInTools(
      extras.writer,
      {
        provider: extras.provider,
        imageProvider: extras.imageProvider,
        webSearchProvider: extras.webSearchProvider,
        deepResearchProvider: extras.deepResearchProvider,
        organization,
        models: input.models,
        toolApprovalLevel: input.toolApprovalLevel,
        isPlanMode,
        toolOutputMap: extras.toolOutputMap,
        pendingImages: extras.pendingImages,
        passthroughClient,
        vmContext,
        htmlArtifactBuffer: extras.htmlArtifactBuffer,
        taskId: extras.threadId,
        agentId: input.agent.id,
        isCodeProject: Boolean(vmMetadata.repository?.url || threadRepo),
        onChildUsage: extras.onChildUsage,
        backgroundDispatcher: extras.backgroundDispatcher,
      },
      ctx,
    );
    const builtInTools = filterBuiltInsByAllowlist(
      allBuiltInTools,
      allowlist,
    ) as typeof allBuiltInTools;

    // Collect (rawName, safeName, connectionId) triples for the
    // connections block and the per-tool annotations used for plan-mode
    // gating — both from the single listTools() round-trip toolsFromMCP
    // already issued (reused via its `rawTools`), as the docstring intends.
    const connectionsBlockTools: ConnectionsBlockTool[] = [];
    const toolAnnotations = new Map<string, { readOnlyHint?: boolean }>();
    for (const t of passthroughToolList) {
      const safeName = passthroughNameMap.get(t.name);
      if (!safeName) continue;
      // Honor the allowlist so the connections block never advertises a tool
      // the model can't actually call. The allowlist holds raw names; accept
      // the safe name too for robustness.
      if (allowlist && !allowlist.has(t.name) && !allowlist.has(safeName)) {
        continue;
      }
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

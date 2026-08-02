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
 *
 * Today this code lives inline inside `stream-core.ts` (~lines 530–660);
 * the helper here is unused until Task 12 wires it through the harness
 * factory. Behavior is intended to be byte-for-byte the same as the
 * inline version, modulo the CLI-agent branch (claude-code / codex)
 * which is removed because the decopilot harness never runs against
 * those providers — they have their own harnesses.
 */

import type { ToolSet, UIMessageStreamWriter } from "ai";
import type { GithubRepo } from "@decocms/shared/sdk";
import type { StudioContext } from "@/core/studio-context";
import { getThreadGithubRepo, threadBranch } from "@/tools/sandbox/thread-repo";
import type { PassthroughClient } from "@/mcp-clients/virtual-mcp/passthrough-client";
import type { StudioProvider } from "@/ai-providers/types";
import type { BackgroundDispatcher } from "@decocms/harness/decopilot/built-in-tools/backgroundable";
import {
  getBuiltInTools,
  type PendingImage,
  type VmContext,
} from "./built-in-tools";
import type { HtmlArtifactBuffer } from "@decocms/harness/decopilot/built-in-tools/vm-tools/types";
import type { ConnectionsBlockTool } from "@decocms/harness/decopilot/connections-block";
import {
  toolsFromMCP,
  type PrOpenedEvent,
  type ToolCallAnalytics,
} from "@decocms/harness/decopilot/mcp-tools";
import { MCP_TOOL_CALL_TIMEOUT_MS } from "@decocms/harness/decopilot/harness-constants";
import { requireDecopilotRunContext } from "@decocms/harness/decopilot/run-context";
import type { HarnessStreamInput } from "@decocms/harness/types";

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
  /** From the loaded memory; used by `vmContext.threadId` to scope
   *  artifacts under `model-outputs/<threadId>/`. Equivalent to
   *  `mem.thread.id` in today's inline code. */
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
  /** Per-turn HTML-artifact fast-path mirror (`org/home/{decks,pages}/
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
   *  background jobs instead of holding the turn open. Omitted on desktop. */
  backgroundDispatcher?: BackgroundDispatcher | null;
  /**
   * Portable MCP-client seam (HarnessDeps `mcpForAgent`). Generalizes the
   * cluster's in-process `createVirtualClientFrom(virtualMcp, ctx, superUser,
   * { listTimeoutMs })` so the daemon/desktop can swap in an HTTP `Client` at
   * the agent's `mcp.url`. The cluster impl
   * (supplied by `index.ts`) loads the Virtual MCP by id and returns a live
   * `PassthroughClient`; the caller owns closing it via `result.close()`.
   */
  mcpForAgent: (
    agentId: string,
    opts?: { superUser?: boolean; listTimeoutMs?: number },
  ) => Promise<PassthroughClient>;
  /** Cluster-injected hook: resolve storage-ref args before each MCP tool
   *  call. Omitted on desktop (no ctx) → args pass through unchanged. */
  resolveArgs?: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  /** Cluster-injected hook: emit per-tool-call analytics (posthog). Omitted
   *  on desktop → no analytics. */
  onToolCalled?: (event: ToolCallAnalytics) => void;
  /** Cluster-injected hook: a PR was opened via the GitHub MCP — link it to
   *  the run's task. Omitted on desktop. */
  onPrOpened?: (event: PrOpenedEvent) => void;
}

/**
 * Built-in tools the agent loop depends on for mechanics (reading truncated
 * outputs, the connections-block lazy-load via enable_tool, todo tracking).
 * These are NEVER subject to the per-run allowlist — removing them would break
 * the loop rather than scope it. The allowlist governs everything else: MCP
 * tools, the user-facing capability built-ins (web_search, generate_image,
 * subtask, …), the VM file tools, the browser tools, and read_resource /
 * read_prompt — all selectable in the automations tool picker.
 */
const ALLOWLIST_EXEMPT_BUILTINS = new Set<string>([
  "read_tool_output",
  "enable_tool",
  "open_in_agent",
  "todo_write",
  "update_interests",
  // Only registered on a run started by a task comment, and it's how that run
  // delivers its answer — scoping it away would leave the comment unanswered.
  "reply_comment",
]);

/**
 * Filter the passthrough (MCP) tool set against the allowlist. The allowlist
 * carries the RAW tool names the UI lists (from `listTools()`), so an MCP
 * tool's model-facing (safe) key survives iff its raw name — or the safe name
 * itself, for robustness — is allowed. A null allowlist is a no-op.
 */
function filterPassthroughByAllowlist(
  set: ToolSet,
  nameMap: Map<string, string>,
  allow: Set<string> | null,
): ToolSet {
  if (!allow) return set;
  const allowedSafe = new Set<string>();
  for (const [raw, safe] of nameMap) {
    if (allow.has(raw) || allow.has(safe)) allowedSafe.add(safe);
  }
  return Object.fromEntries(
    Object.entries(set).filter(([name]) => allowedSafe.has(name)),
  );
}

/**
 * Filter built-ins against the allowlist, always keeping the loop-essential
 * ones. A null allowlist is a no-op.
 */
function filterBuiltInsByAllowlist(
  set: ToolSet,
  allow: Set<string> | null,
): ToolSet {
  if (!allow) return set;
  return Object.fromEntries(
    Object.entries(set).filter(
      ([name]) => ALLOWLIST_EXEMPT_BUILTINS.has(name) || allow.has(name),
    ),
  );
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

  // superUser=true: the user is already authenticated as an org member,
  // the virtual MCP enforces which connections are in scope, and the
  // per-tool AuthTransport check would block every non-public connection
  // tool (GitHub, Slack, etc.) for users who don't have explicit per-tool
  // permissions configured — the wrong enforcement layer for chat.
  const passthroughClient = await extras.mcpForAgent(input.agent.id, {
    superUser: true,
    listTimeoutMs: 1_000,
  });

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
        resolveArgs: extras.resolveArgs,
        onToolCalled: extras.onToolCalled,
        onPrOpened: extras.onPrOpened,
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
    const vmMetadata = runContext.virtualMcp.metadata as {
      githubRepo?: GithubRepo | null;
    };
    // A thread-scoped repo (set by `load_repo`, super-agent-only) wins: it's the
    // only place a repo can persist for the synthetic Decopilot agent. Threads of
    // real repo-agents never carry one. When present it pins the thread to a
    // dedicated `thread:<id>` sandbox branch (not the shared "ephemeral" one).
    const threadRepo = await getThreadGithubRepo(ctx, extras.threadId);
    const effectiveRepo = threadRepo ?? vmMetadata.githubRepo;
    const isEphemeralAgent = !effectiveRepo;
    const vmContext: VmContext | null = input.user.id
      ? {
          virtualMcpId: input.agent.id,
          branch: threadRepo
            ? threadBranch(extras.threadId, threadRepo.connectionId)
            : isEphemeralAgent
              ? "ephemeral"
              : (runContext.branch ?? `thread:${extras.threadId}`),
          userId: input.user.id,
          // Used by share_with_user to scope artifacts under
          // model-outputs/<threadId>/. Cannot be derived from the
          // sandbox row since one ephemeral sandbox serves many threads.
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

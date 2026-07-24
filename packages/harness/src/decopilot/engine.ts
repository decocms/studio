/**
 * Portable engine + assembled-tools seam for the shared Decopilot core.
 *
 * These interfaces are the narrow boundary between the portable orchestration
 * (`run-core.ts` / `run-stream.ts`) and the environment adapters:
 *   - `HarnessAssembledTools` — the tool-set bundle the orchestration reads.
 *     The cluster `AssembledTools` (`./tools`) structurally satisfies it; the
 *     desktop builds an equivalent in Task 15. Includes the per-run side
 *     channel + writer + pending-images + step-finish hook that the adapter
 *     owns and the loop merges.
 *   - `RunEngineArgs` / `AssembledEngineHandle` — the engine the orchestration
 *     drives. The cluster closes over `ctx` + `organization` and delegates to
 *     `runAgentLoop`; the desktop (Task 15) delegates to
 *     `runNativeAgentLoopCore`. The ctx-coupled args are NOT in this shape —
 *     the adapter's `runEngine` closure captures them.
 *
 * `@/*`-free: imports only AI-SDK + MCP-SDK + relative portable leaves.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Span } from "@opentelemetry/api";
import type {
  ModelMessage,
  StreamTextOnStepFinishCallback,
  StreamTextResult,
  SystemModelMessage,
  ToolSet,
  UIMessageChunk,
  UIMessageStreamWriter,
} from "ai";
import type { GithubRepo } from "@decocms/shared/sdk";
import type { ConnectionsBlockTool } from "./connections-block";
import type { PendingImage } from "./built-in-tools/vm-tools/types";
import type { ModelsConfig } from "../types";
import type { StudioProvider } from "./studio-provider";
import type { CodingWorkspacePromptInput } from "../coding-workspace-prompt";

/**
 * The assembled tool-set bundle the orchestration reads. The cluster
 * `AssembledTools` is assignable to this (it carries every field plus a few
 * cluster-only extras). The side-channel / writer / pending-images /
 * step-finish hook are produced by the environment adapter (the cluster
 * factory owns the html-page buffer + side-channel writer lifecycle) and
 * threaded through so the loop can merge them.
 */
export interface HarnessAssembledTools {
  /** Combined tool set: passthrough MCP tools + built-in platform tools.
   *  `enable_tool` is attached later by the loop from reconstructed state. */
  tools: ToolSet;
  /** Subset of the toolset that came from the MCP passthrough — used by
   *  `enable_tool` to enumerate activatable tools. */
  passthroughTools: ToolSet;
  /** The platform built-in tools (heavy tools: VM, web_search, screenshot…)
   *  injected into the engine as extra tools. */
  builtInTools: ToolSet;
  /** Connection-block entries derived from the MCP tool listing — feeds the
   *  `<available-connections>` prompt block + enable_tool. */
  connectionsBlockTools: ConnectionsBlockTool[];
  /** Read-only hints per safe tool name, for plan-mode gating. */
  toolAnnotations: Map<string, { readOnlyHint?: boolean }>;
  /** Connection id → human title — feeds the connections block. */
  connectionTitleMap: Map<string, string>;
  /** Server-provided agent instructions from the MCP — agent identity for
   *  non-decopilot agents. */
  serverInstructions: string | undefined;
  /** The live MCP passthrough client (in-process on the cluster, HTTP on the
   *  desktop). The adapter owns its lifecycle. */
  passthroughClient: Client;

  // ── Per-run streaming wiring owned by the adapter ───────────────────
  /** Forwarded UIMessageStreamWriter the built-in tools stream output through. */
  writer: UIMessageStreamWriter;
  /** Screenshot images captured by `take_screenshot`, shared by reference with
   *  the built-in tools and `prepareStep` (mutated in place). */
  pendingImages: PendingImage[];
  /** Tool side-channel chunks merged into the main UI stream. */
  sideChunks?: AsyncIterable<UIMessageChunk>;
  closeSideChunks?: () => void;
  /** Step-finish hook (e.g. html-page flush). */
  onStepFinish?: StreamTextOnStepFinishCallback<ToolSet>;
  /** Cleanup — closes the passthrough client + side channel. */
  close(): Promise<void>;
}

/**
 * Portable args for the engine call. Mirrors the `runAgentLoop` call site in
 * the cluster, MINUS the ctx-coupled args (`ctx`, `organization`) which the
 * adapter's `runEngine` closure captures. The engine assembles the real system
 * prompt + tool set and runs streamText.
 */
export interface RunEngineArgs {
  kind: "agent" | "subagent";
  virtualMcp: {
    id: string;
    repo?: GithubRepo;
    delegationTargetIds?: string[] | null;
  };
  mcpClient: Client;
  provider: StudioProvider;
  models: ModelsConfig;
  messages: ModelMessage[];
  abortSignal: AbortSignal;
  temperature: number;
  planMode: boolean;
  isDecopilot: boolean;
  codingWorkspace?: CodingWorkspacePromptInput;
  systemAgentInstructions?: string;
  currentThreadId: string;
  /** Authenticated user identity for the user-context prompt block. */
  user?: { id: string; name?: string | null; email?: string | null };
  /** Pre-resolved prompt data (threads/interests/agents) for the system prompt. */
  userContext?: import("../types").HarnessUserContext;
  writer: UIMessageStreamWriter;
  /** Image-injection + plan-mode-filter prepareStep built by the loop. */
  prepareStep: unknown;
  onStepFinish?: StreamTextOnStepFinishCallback<ToolSet>;
  passthroughClient: Client;
  connectionsData: {
    tools: ConnectionsBlockTool[];
    connectionTitleMap: Map<string, string>;
  };
  /** Built-in tools + the state-dependent enable_tool, merged after the
   *  engine's own assembly. */
  extraTools: ToolSet;
  /** Per-request inline <system> blocks + the currently-enabled-tools tail. */
  additionalSystemMessages: SystemModelMessage[];
  /** Optional step-budget override. The shared core passes
   *  `SUBAGENT_STEP_LIMIT` for delegated `subtask` runs (`kind: "subtask"`);
   *  main runs leave it undefined so the engine derives its default
   *  (`PARENT_STEP_LIMIT`). */
  stepLimit?: number;
}

/**
 * The engine handle the orchestration drives: the streamText result, an error
 * promise, and the loop's OTel span. Matches the cluster `RunAgentLoopHandle`.
 */
export interface AssembledEngineHandle {
  result: StreamTextResult<ToolSet, never>;
  error: Promise<string | undefined>;
  span: Span;
  /** The system messages the engine actually assembled and sent to the model.
   *  Feeds the `_request.systemSections` debug metadata (the single surviving
   *  prompt assembler — see run-core / run-stream). */
  assembledSystemMessages: { role: "system"; content: string }[];
}

/** The engine function shape the tool runtime supplies. */
export type RunEngine = (args: RunEngineArgs) => Promise<AssembledEngineHandle>;

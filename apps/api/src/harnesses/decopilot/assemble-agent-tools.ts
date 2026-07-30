/**
 * assembleAgentTools — shared tool assembler for both parent agents
 * and subagents in the decopilot harness.
 *
 * Returns the full toolset (MCP + built-ins), the shared toolOutputMap
 * (used by read_tool_output to read back truncated outputs), and the
 * nameMap (mcp-tool short-name -> full-name).
 *
 * Rules:
 *   - `kind: "subagent"` excludes `subtask`, `user_ask`, `propose_plan`.
 *   - Truncation is ALWAYS on (disableOutputTruncation: false).
 *   - `toolApprovalLevel` is passed through as-is from the caller.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolSet, UIMessageStreamWriter } from "ai";
import type { StudioContext } from "@/core/studio-context";
import {
  toolsFromMCP,
  type PrOpenedEvent,
  type ToolApprovalLevel,
  type ToolCallAnalytics,
} from "@decocms/harness/decopilot/mcp-tools";
import { MCP_TOOL_CALL_TIMEOUT_MS } from "@decocms/harness/decopilot/harness-constants";
import {
  buildBuiltInTools,
  getBuiltInTools,
  type BuildBuiltInToolsOptions,
  type BuiltinToolParams,
} from "./built-in-tools";

export type { BuildBuiltInToolsOptions };
export type { ToolApprovalLevel };

const EXCLUDED_FOR_SUBAGENT = ["subtask", "user_ask", "propose_plan"] as const;

export interface AssembleAgentToolsOptions {
  kind: "agent" | "subagent";
  ctx: StudioContext;
  mcpClient: Client;
  writer: UIMessageStreamWriter;
  planMode: boolean;
  toolApprovalLevel: ToolApprovalLevel;
  subtaskParams: BuildBuiltInToolsOptions["subtaskParams"];
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
  /**
   * Full built-in params for a SUBAGENT. When present (the `subtask` paths), the
   * subagent is built with the SAME heavy built-ins the parent has — vm file
   * tools (read/write/edit/bash/…), generate_image, web_search, screenshot —
   * instead of the light core. Without it a subagent only sees todo_write +
   * read_tool_output, so a delegated task can't write files or generate images.
   * The loop's own `toolOutputMap` is injected here so MCP outputs and
   * read_tool_output share one map; excluded subagent tools are still stripped.
   * Omitted by the main-agent path, which injects its full built-ins via
   * extraTools instead.
   */
  fullBuiltInParams?: Omit<BuiltinToolParams, "toolOutputMap">;
  /** The caller's `read_tool_output` map. The main-agent path MUST pass it:
   *  its `read_tool_output` comes in via `extraTools` bound to that map, so a
   *  fresh one here would swallow every truncated MCP output. Omitted by the
   *  subagent path, which takes its built-ins from `fullBuiltInParams`. */
  toolOutputMap?: Map<string, string>;
}

export interface AssembleAgentToolsResult {
  tools: ToolSet;
  toolOutputMap: Map<string, string>;
  nameMap: Map<string, string>;
}

export async function assembleAgentTools(
  opts: AssembleAgentToolsOptions,
): Promise<AssembleAgentToolsResult> {
  const toolOutputMap = opts.toolOutputMap ?? new Map<string, string>();

  // 1. MCP tools — truncation always on.
  const { tools: mcpTools, nameMap } = await toolsFromMCP(
    opts.mcpClient,
    toolOutputMap,
    opts.writer,
    opts.toolApprovalLevel,
    {
      disableOutputTruncation: false,
      isPlanMode: opts.planMode,
      timeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
      resolveArgs: opts.resolveArgs,
      onToolCalled: opts.onToolCalled,
      onPrOpened: opts.onPrOpened,
    },
  );

  // 2. Built-in tools — full set first. A subagent given `fullBuiltInParams`
  //    gets the parent's heavy built-ins (vm/generate_image/web_search) bound to
  //    THIS loop's writer + the shared toolOutputMap; otherwise the light core.
  const allBuiltIns = opts.fullBuiltInParams
    ? await getBuiltInTools(
        opts.writer,
        { ...opts.fullBuiltInParams, toolOutputMap },
        opts.ctx,
      )
    : buildBuiltInTools({
        ctx: opts.ctx,
        writer: opts.writer,
        toolOutputMap,
        subtaskParams: opts.subtaskParams,
        planMode: opts.planMode,
      });

  // 3. Filter built-ins for subagent kind.
  const builtIns: Record<string, unknown> =
    opts.kind === "subagent"
      ? Object.fromEntries(
          Object.entries(allBuiltIns).filter(
            ([name]) =>
              !EXCLUDED_FOR_SUBAGENT.includes(
                name as (typeof EXCLUDED_FOR_SUBAGENT)[number],
              ),
          ),
        )
      : allBuiltIns;

  // 4. Merge.
  const tools: ToolSet = { ...mcpTools, ...(builtIns as ToolSet) };

  return { tools, toolOutputMap, nameMap };
}

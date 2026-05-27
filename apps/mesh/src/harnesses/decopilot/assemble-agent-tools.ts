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
import type { MeshContext } from "@/core/mesh-context";
import {
  toolsFromMCP,
  type ToolApprovalLevel,
} from "../../api/routes/decopilot/helpers";
import {
  buildBuiltInTools,
  type BuildBuiltInToolsOptions,
} from "./built-in-tools";

export type { BuildBuiltInToolsOptions };
export type { ToolApprovalLevel };

export const EXCLUDED_FOR_SUBAGENT = [
  "subtask",
  "user_ask",
  "propose_plan",
] as const;

export interface AssembleAgentToolsOptions {
  kind: "agent" | "subagent";
  ctx: MeshContext;
  mcpClient: Client;
  writer: UIMessageStreamWriter;
  planMode: boolean;
  toolApprovalLevel: ToolApprovalLevel;
  subtaskParams: BuildBuiltInToolsOptions["subtaskParams"];
}

export interface AssembleAgentToolsResult {
  tools: ToolSet;
  toolOutputMap: Map<string, string>;
  nameMap: Map<string, string>;
}

export async function assembleAgentTools(
  opts: AssembleAgentToolsOptions,
): Promise<AssembleAgentToolsResult> {
  const toolOutputMap = new Map<string, string>();

  // 1. MCP tools — truncation always on.
  const { tools: mcpTools, nameMap } = await toolsFromMCP(
    opts.mcpClient,
    toolOutputMap,
    opts.writer,
    opts.toolApprovalLevel,
    {
      disableOutputTruncation: false,
      ctx: opts.ctx,
      isPlanMode: opts.planMode,
    },
  );

  // 2. Built-in tools — full set first.
  const allBuiltIns = buildBuiltInTools({
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

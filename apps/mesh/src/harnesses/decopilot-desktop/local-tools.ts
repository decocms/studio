/**
 * Desktop built-in tool adapter.
 *
 * The implementation lives in the shared Decopilot portable built-ins module;
 * this file only preserves the desktop harness import boundary and parameter
 * names.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolSet, UIMessageStreamWriter } from "ai";
import {
  buildPortableBuiltInTools,
  type PortableSubtaskModels,
} from "../decopilot/built-in-tools/portable-built-ins";
import type { VirtualClient } from "../decopilot/built-in-tools/sandbox";
import type { ToolApprovalLevel } from "../decopilot/mcp-tools";
import type { DesktopToolCtx } from "./types";

export interface DesktopSubtaskModels extends PortableSubtaskModels {}

export interface BuildLocalToolsParams {
  writer: UIMessageStreamWriter;
  toolOutputMap: Map<string, string>;
  passthroughClient: VirtualClient;
  toolApprovalLevel: ToolApprovalLevel;
  isPlanMode: boolean;
  ctx: DesktopToolCtx;
  mcpClient?: Client;
  models?: DesktopSubtaskModels;
  selfAgentId?: string;
}

export function buildLocalTools(params: BuildLocalToolsParams): ToolSet {
  return buildPortableBuiltInTools({
    writer: params.writer,
    toolOutputMap: params.toolOutputMap,
    passthroughClient: params.passthroughClient,
    toolApprovalLevel: params.toolApprovalLevel,
    isPlanMode: params.isPlanMode,
    objectStorage: params.ctx.objectStorage,
    subtaskRelay:
      params.mcpClient && params.models && params.selfAgentId
        ? {
            mcpClient: params.mcpClient,
            models: params.models,
            selfAgentId: params.selfAgentId,
          }
        : undefined,
  });
}

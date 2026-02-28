"use client";

import { Suspense } from "react";
import type { ToolUIPart, DynamicToolUIPart } from "ai";
import type { ToolDefinition } from "@decocms/mesh-sdk";
import { useProjectContext } from "@decocms/mesh-sdk";
import { getUIResourceUri } from "@/mcp-apps/types.ts";
import { Atom02, LayersTwo01 } from "@untitledui/icons";
import { useChatStable } from "@/web/components/chat/context.tsx";
import { ToolCallShell } from "./common.tsx";
import {
  getFriendlyToolName,
  getApprovalId,
  getEffectiveState,
} from "./utils.tsx";
import { getToolPartErrorText, safeStringify } from "../utils.ts";
import { ApprovalActions } from "./approval-actions.tsx";
import { MCPAppLoader } from "@/mcp-apps/mcp-app-loader.tsx";

interface GenericToolCallPartProps {
  part: ToolUIPart | DynamicToolUIPart;
  /** Kept for backwards compatibility with assistant.tsx call sites (unused internally) */
  id?: string;
  /** Optional MCP tool annotations to render as badges */
  annotations?: ToolDefinition["annotations"];
  /** Latency in seconds from data-tool-metadata part */
  latency?: number;
}

function safeStringifyFormatted(value: unknown): string {
  const str = safeStringify(value);
  if (str === "" || str === "[Non-serializable value]") return str;
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function getTitle(state: string, friendlyName: string): string {
  switch (state) {
    case "input-streaming":
    case "input-available":
      return `Calling ${friendlyName}...`;
    case "approval-requested":
      return `Approve ${friendlyName}`;
    case "output-denied":
      return `Denied ${friendlyName}`;
    case "output-available":
      return `Called ${friendlyName}`;
    case "output-error":
      return `Error calling ${friendlyName}`;
    default:
      return `Calling ${friendlyName}...`;
  }
}

function getSummary(state: string): string {
  switch (state) {
    case "input-streaming":
    case "input-available":
      return "Generating input";
    case "approval-requested":
      return "Waiting for approval";
    case "output-denied":
      return "Execution denied";
    case "output-available":
      return "Tool answered";
    case "output-error":
      return "Tool failed";
    default:
      return "Calling tool";
  }
}

export function GenericToolCallPart({
  part,
  annotations,
  latency,
}: GenericToolCallPartProps) {
  // Extract tool name with proper dynamic-tool handling
  const toolName =
    "toolName" in part && typeof part.toolName === "string"
      ? part.toolName
      : part.type === "dynamic-tool"
        ? "Dynamic Tool"
        : part.type.replace("tool-", "") || "Tool";
  const friendlyName = getFriendlyToolName(toolName);

  const { selectedVirtualMcp } = useChatStable();
  const { org } = useProjectContext();

  const toolOutput = part.output;
  // Extract _meta from tool output. The output may be either:
  // 1. A CallToolResult with structuredContent containing _meta
  // 2. The raw structured content directly with _meta at top level
  const toolMeta = (() => {
    if (toolOutput == null || typeof toolOutput !== "object") return undefined;
    const out = toolOutput as Record<string, unknown>;
    // Check structuredContent first (CallToolResult wrapper)
    if (
      out.structuredContent != null &&
      typeof out.structuredContent === "object"
    ) {
      const sc = out.structuredContent as Record<string, unknown>;
      if ("_meta" in sc) return sc._meta as Record<string, unknown> | undefined;
    }
    // Fall back to top-level _meta
    if ("_meta" in out) return out._meta as Record<string, unknown> | undefined;
    return undefined;
  })();

  const uiResourceUri = getUIResourceUri(toolMeta);

  const connectionId =
    toolMeta &&
    typeof toolMeta === "object" &&
    toolMeta !== null &&
    "connectionId" in toolMeta
      ? String(toolMeta.connectionId)
      : (selectedVirtualMcp?.id ?? null);

  const hasMCPApp = !!uiResourceUri && part.state === "output-available";
  const canRenderMCPApp = hasMCPApp && !!connectionId && !!org?.id;

  // Compute state-dependent props
  const title = getTitle(part.state, friendlyName);
  const summary = getSummary(part.state);

  // Derive UI state for ToolCallShell
  const effectiveState = getEffectiveState(part.state);

  // Build expanded content
  let detail = "";
  if (part.input !== undefined) {
    detail += "# Input\n" + safeStringifyFormatted(part.input);
  }

  if (part.state === "output-error") {
    const errorText = getToolPartErrorText(part);
    if (detail) detail += "\n\n";
    detail += "# Error\n" + errorText;
  } else if (part.output !== undefined && !hasMCPApp) {
    if (detail) detail += "\n\n";
    detail += "# Output\n" + safeStringifyFormatted(part.output);
  }

  // Build approval actions for approval-requested state
  const approvalId = getApprovalId(part);
  const actions = approvalId ? (
    <ApprovalActions approvalId={approvalId} />
  ) : undefined;

  return (
    <div className="my-2">
      <ToolCallShell
        icon={
          hasMCPApp ? (
            <LayersTwo01 className="size-4 text-muted-foreground" />
          ) : (
            <Atom02 className="size-4 text-muted-foreground" />
          )
        }
        title={title}
        annotations={annotations}
        latency={latency}
        summary={summary}
        state={effectiveState}
        detail={detail || null}
        actions={actions}
      />
      {canRenderMCPApp && (
        <div className="mt-2 border border-border/75 rounded-lg overflow-hidden p-3">
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-32">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <div className="size-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm">Loading app...</span>
                </div>
              </div>
            }
          >
            <MCPAppLoader
              uiResourceUri={uiResourceUri!}
              connectionId={connectionId!}
              orgId={org!.id}
              toolName={toolName}
              toolInput={part.input}
              toolResult={part.output}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

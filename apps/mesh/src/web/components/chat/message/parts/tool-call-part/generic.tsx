"use client";

import { MCPAppRenderer as MCPAppIframeRenderer } from "@/mcp-apps/mcp-app-renderer.tsx";
import { getUIResourceUri } from "@/mcp-apps/types.ts";
import { useChatStable } from "@/web/components/chat/context.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import type { ToolDefinition } from "@decocms/mesh-sdk";
import { useMCPClient, useProjectContext } from "@decocms/mesh-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AlertCircle,
  Atom02,
  Eye,
  Globe02,
  LayersTwo01,
  XClose,
} from "@untitledui/icons";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type React from "react";
import { Suspense } from "react";
import { getToolPartErrorText, safeStringify } from "../utils.ts";
import { ApprovalActions } from "./approval-actions.tsx";
import { ToolCallShell } from "./common.tsx";
import {
  getApprovalId,
  getEffectiveState,
  getFriendlyToolName,
} from "./utils.tsx";

interface GenericToolCallPartProps {
  part: ToolUIPart | DynamicToolUIPart;
  /** Kept for backwards compatibility with assistant.tsx call sites (unused internally) */
  id?: string;
  /** Tool annotations — used to derive the tool icon (destructive, openWorld, or default) */
  annotations?: ToolDefinition["annotations"];
  /** Latency in seconds from data-tool-metadata part */
  latency?: number;
  /** Whether this part belongs to the last (most recent) assistant message */
  isLastMessage?: boolean;
  /** Tool _meta from data-tool-metadata part */
  toolMeta?: ToolDefinition["_meta"];
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

function AnnotationBadge({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center">{icon}</span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function AnnotationBadges({
  annotations,
  toolMeta,
}: {
  annotations?: ToolDefinition["annotations"];
  toolMeta?: ToolDefinition["_meta"];
}) {
  const hasUI = !!getUIResourceUri(toolMeta);
  if (!annotations && !hasUI) return null;
  return (
    <>
      {hasUI && <AnnotationBadge icon={<LayersTwo01 />} label="Interactive" />}
      {annotations?.readOnlyHint && (
        <AnnotationBadge icon={<Eye />} label="Read-only — no side effects" />
      )}
      {annotations?.destructiveHint && (
        <AnnotationBadge
          icon={<AlertCircle />}
          label="May modify or delete data"
        />
      )}
      {annotations?.openWorldHint && (
        <AnnotationBadge
          icon={<Globe02 />}
          label="Reaches outside this system"
        />
      )}
    </>
  );
}

/** Returns a short status hint shown on the summary line */
function getSummary(
  state: string,
  output?: unknown,
  errorText?: string,
): string {
  switch (state) {
    case "input-streaming":
    case "input-available":
      return "Preparing...";
    case "approval-requested":
      return "Waiting for your approval";
    case "output-denied":
      return "Cancelled";
    case "output-error":
      return errorText ?? "Failed";
    case "output-available": {
      // Try to surface a concise result snippet
      if (output == null) return "Done";
      if (typeof output === "string") {
        const trimmed = output.trim();
        return trimmed.length > 100 ? trimmed.slice(0, 100) + "…" : trimmed;
      }
      if (typeof output === "object") {
        // Try to surface the first string value in the object
        for (const key of Object.keys(output as object)) {
          const val = (output as Record<string, unknown>)[key];
          if (typeof val === "string" && val.trim()) {
            const trimmed = val.trim();
            return trimmed.length > 100 ? trimmed.slice(0, 100) + "…" : trimmed;
          }
        }
        // Object with no surfaceable string — let the expanded detail speak for itself
        return "";
      }
      return String(output).slice(0, 100);
    }
    default:
      return "";
  }
}

export function GenericToolCallPart({
  part,
  annotations,
  latency,
  isLastMessage,
  toolMeta,
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

  const uiResourceUri = getUIResourceUri(toolMeta);

  const connectionId =
    toolMeta &&
    typeof toolMeta === "object" &&
    toolMeta !== null &&
    "connectionId" in toolMeta &&
    toolMeta.connectionId != null &&
    toolMeta.connectionId !== ""
      ? String(toolMeta.connectionId)
      : (selectedVirtualMcp?.id ?? null);

  const hasMCPApp = !!uiResourceUri && part.state === "output-available";

  // Compute state-dependent props
  // Cancelled = explicitly denied OR stale approval (conversation moved on)
  const isStaleApproval =
    part.state === "approval-requested" && isLastMessage === false;
  const isCancelled = part.state === "output-denied" || isStaleApproval;
  const effectiveState = isStaleApproval
    ? "idle"
    : getEffectiveState(part.state);

  // Error text (used in summary and detail)
  const errorText =
    part.state === "output-error" ? getToolPartErrorText(part) : undefined;

  const summary = isStaleApproval
    ? "Cancelled"
    : getSummary(part.state, part.output, errorText);

  // Build expanded content
  let detail = "";
  if (part.input !== undefined) {
    detail += "# Input\n" + safeStringifyFormatted(part.input);
  }

  if (part.state === "output-error") {
    if (detail) detail += "\n\n";
    detail += "# Error\n" + (errorText ?? "");
  } else if (part.output !== undefined && !hasMCPApp) {
    if (detail) detail += "\n\n";
    detail += "# Output\n" + safeStringifyFormatted(part.output);
  }

  // Build approval actions for approval-requested state (only when not stale)
  const approvalId = !isStaleApproval ? getApprovalId(part) : null;
  const actions = approvalId ? (
    <ApprovalActions approvalId={approvalId} />
  ) : undefined;

  return (
    <div className={cn(effectiveState === "approval" && "my-2")}>
      <ToolCallShell
        icon={
          isCancelled ? (
            <XClose />
          ) : hasMCPApp ? (
            <LayersTwo01 className="size-4 text-muted-foreground" />
          ) : (
            <Atom02 className="size-4 text-muted-foreground" />
          )
        }
        iconDestructive={isCancelled}
        trailing={
          <AnnotationBadges annotations={annotations} toolMeta={toolMeta} />
        }
        title={friendlyName}
        latency={latency}
        summary={summary}
        state={effectiveState}
        detail={detail || null}
        actions={actions}
      />
      {hasMCPApp && uiResourceUri && connectionId && org?.id && (
        <Suspense
          fallback={
            <div className="mt-2 flex items-center justify-center h-12 border border-border/75 rounded-lg overflow-hidden p-3">
              <div className="flex items-center gap-2 text-muted-foreground">
                <div className="size-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                <span className="text-sm">Loading app...</span>
              </div>
            </div>
          }
        >
          <MCPAppRenderer
            uiResourceUri={uiResourceUri}
            connectionId={connectionId}
            orgId={org.id}
            toolName={toolName}
            toolInput={part.input}
            toolResult={part.output}
          />
        </Suspense>
      )}
    </div>
  );
}

interface MCPAppRendererProps {
  uiResourceUri: string;
  connectionId: string;
  orgId: string;
  toolName: string;
  toolInput: unknown;
  toolResult: unknown;
}

function MCPAppRenderer({
  uiResourceUri,
  connectionId,
  orgId,
  toolName,
  toolInput,
  toolResult,
}: MCPAppRendererProps) {
  const client = useMCPClient({ connectionId, orgId });

  return (
    <div className="mt-2 border border-border/75 rounded-lg overflow-hidden p-3">
      <MCPAppIframeRenderer
        resourceURI={uiResourceUri}
        toolName={toolName}
        toolInput={toolInput as Record<string, unknown> | undefined}
        toolResult={toolResult as CallToolResult | undefined}
        client={client}
      />
    </div>
  );
}

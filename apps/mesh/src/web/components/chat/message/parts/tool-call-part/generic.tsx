"use client";

import { contentBlocksToTiptapDoc } from "@/mcp-apps/content-blocks.ts";
import { MCPAppRenderer as MCPAppIframeRenderer } from "@/mcp-apps/mcp-app-renderer.tsx";
import { getUIResourceUri } from "@/mcp-apps/types.ts";
import {
  useOptionalChatStream,
  useOptionalChatPrefs,
} from "@/web/components/chat/context.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";

import type { ToolDefinition } from "@decocms/mesh-sdk";
import { useMCPClient, useProjectContext } from "@decocms/mesh-sdk";
import {
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import { stripMcpServerPrefix } from "@/web/lib/tool-namespace";
import { useToolDefinitionLookup } from "@/web/hooks/use-tool-definition-lookup";
import { toTitleCase } from "./utils.tsx";
import type {
  McpUiMessageRequest,
  McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  AlertCircle,
  Atom02,
  Expand06,
  Eye,
  Globe02,
  LayersTwo01,
  RefreshCw01,
  XClose,
} from "@untitledui/icons";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type React from "react";
import { Suspense, useContext } from "react";
import { ErrorBoundary } from "@/web/components/error-boundary.tsx";
import { PanelContext } from "@/web/contexts/panel-context.tsx";

import { getToolPartErrorText, safeStringify } from "../utils.ts";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";

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
  const rawToolName =
    "toolName" in part && typeof part.toolName === "string"
      ? part.toolName
      : part.type === "dynamic-tool"
        ? "Dynamic Tool"
        : part.type.replace("tool-", "") || "Tool";
  // Strip mcp__<server>__ prefix (e.g. mcp__cms__conn-abc_hello → conn-abc_hello)
  const mcpStrippedName = stripMcpServerPrefix(rawToolName);

  const chatStream = useOptionalChatStream();
  const chatPrefs = useOptionalChatPrefs();
  const { org } = useProjectContext();

  // Panel context may not be available when rendering read-only thread history
  // (e.g. monitoring Threads tab), so we read the context directly.
  const panelControls = useContext(PanelContext);
  const setChatOpen = panelControls?.setChatOpen;

  const connectionId =
    toolMeta &&
    typeof toolMeta === "object" &&
    toolMeta !== null &&
    "connectionId" in toolMeta &&
    toolMeta.connectionId != null &&
    toolMeta.connectionId !== ""
      ? String(toolMeta.connectionId)
      : (chatPrefs?.selectedVirtualMcp?.id ?? null);

  // Look up tool definition from virtual MCP's listTools.
  // Single source of truth for _meta, title, gatewayClientId, uiResourceUri.
  const { toolDef } = useToolDefinitionLookup(
    connectionId ? rawToolName : null,
    connectionId,
    org.id,
  );
  const meta = toolDef?._meta ?? toolMeta;
  const gatewayClientId = getGatewayClientId(meta);
  const toolName = stripToolNamespace(mcpStrippedName, gatewayClientId);
  const friendlyName = toolDef?.title ?? toTitleCase(toolName);
  const uiResourceUri = getUIResourceUri(meta);

  const hasMCPApp = !!uiResourceUri && part.state === "output-available";
  const sourceId = connectionId ? `${connectionId}:${rawToolName}` : null;
  const isDestructive = !!annotations?.destructiveHint;
  const canOpenInPanel =
    hasMCPApp && !!panelControls && !!connectionId && !isDestructive;

  const handleOpenInPanel = () => {
    if (!connectionId || !panelControls) return;
    panelControls.openMainView("ext-apps", {
      id: connectionId,
      toolName: rawToolName,
    });
  };

  const handleAppMessage = (params: McpUiMessageRequest["params"]) => {
    const doc = contentBlocksToTiptapDoc(params.content);
    if (doc.content.length > 0) {
      setChatOpen?.(true);
      chatStream?.sendMessage(doc);
    }
  };

  // Compute state-dependent props
  // Cancelled = explicitly denied OR stale approval (conversation moved on)
  const isStaleApproval =
    part.state === "approval-requested" && isLastMessage === false;
  const isCancelled = part.state === "output-denied" || isStaleApproval;
  // Approval-requested parts render as idle inline (approval UI is in the highlight above input)
  const rawState = getEffectiveState(part.state);
  const effectiveState =
    isStaleApproval || rawState === "approval" ? "idle" : rawState;

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

  return (
    <div>
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
      />
      {canOpenInPanel && (
        <div className="flex justify-end mt-1.5 mb-1">
          <button
            type="button"
            onClick={handleOpenInPanel}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground rounded-md [@media(hover:hover)]:hover:bg-accent/50 [@media(hover:hover)]:hover:text-foreground transition-colors"
          >
            <Expand06 className="size-3.5" />
            Open in panel
          </button>
        </div>
      )}
      {hasMCPApp && uiResourceUri && connectionId && org?.id && (
        <>
          <ErrorBoundary
            fallback={({ resetError }) => (
              <div className="mt-2 flex items-center gap-2 px-3 py-2.5 border border-dashed border-destructive/30 bg-destructive/5 rounded-lg">
                <AlertCircle size={16} className="shrink-0 text-destructive" />
                <span className="flex-1 text-xs text-destructive font-medium">
                  Failed to load{" "}
                  <span className="font-mono">{friendlyName}</span> app
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5 shrink-0"
                  onClick={resetError}
                >
                  <RefreshCw01 className="size-3.5" />
                  Retry
                </Button>
              </div>
            )}
          >
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
                toolMeta={meta as Record<string, unknown> | undefined}
                onMessage={handleAppMessage}
                onUpdateModelContext={
                  sourceId && chatPrefs
                    ? (params) => chatPrefs.setAppContext(sourceId, params)
                    : undefined
                }
                onTeardown={
                  sourceId && chatPrefs
                    ? () => chatPrefs.clearAppContext(sourceId)
                    : undefined
                }
              />
            </Suspense>
          </ErrorBoundary>
        </>
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
  toolMeta?: Record<string, unknown>;
  onMessage?: (params: McpUiMessageRequest["params"]) => void;
  onUpdateModelContext?: (
    params: McpUiUpdateModelContextRequest["params"],
  ) => void;
  onTeardown?: () => void;
}

/**
 * Check if a value is a Codex mcpToolCall envelope.
 * Codex wraps MCP tool calls in { type: "mcpToolCall", ... } objects.
 */
function isMcpToolCallEnvelope(
  value: unknown,
): value is { type: "mcpToolCall"; [key: string]: unknown } {
  return (
    typeof value === "object" &&
    value != null &&
    "type" in value &&
    (value as Record<string, unknown>).type === "mcpToolCall"
  );
}

/**
 * Normalize tool input across providers.
 * Codex wraps input in { type: "mcpToolCall", arguments: { ... } } —
 * unwrap to get the actual tool arguments.
 */
function normalizeToolInput(
  input: unknown,
): Record<string, unknown> | undefined {
  if (input == null) return undefined;
  if (isMcpToolCallEnvelope(input)) {
    return (input.arguments as Record<string, unknown>) ?? undefined;
  }
  return input as Record<string, unknown>;
}

/**
 * Normalize a tool result to CallToolResult format.
 * - Standard AI SDK tools: already a CallToolResult
 * - Claude Code dynamic tools: raw parsed JSON (no wrapper)
 * - Codex: { type: "mcpToolCall", result: CallToolResult, ... } wrapped
 *   inside structuredContent
 */
function normalizeToolResult(output: unknown): CallToolResult | undefined {
  if (output == null) return undefined;

  // Codex: output itself is the mcpToolCall envelope
  if (isMcpToolCallEnvelope(output) && output.result != null) {
    return output.result as CallToolResult;
  }

  // Already a CallToolResult (has content array with MCP content blocks)
  if (
    typeof output === "object" &&
    "content" in output &&
    Array.isArray((output as CallToolResult).content)
  ) {
    const arr = (output as CallToolResult).content;
    if (
      arr.length > 0 &&
      typeof arr[0] === "object" &&
      arr[0] != null &&
      "type" in arr[0]
    ) {
      return output as CallToolResult;
    }
  }

  // Wrap raw value (Claude Code) in CallToolResult format
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return {
    structuredContent:
      typeof output === "object" && !Array.isArray(output)
        ? (output as Record<string, unknown>)
        : undefined,
    content: [{ type: "text", text }],
  };
}

function MCPAppRenderer({
  uiResourceUri,
  connectionId,
  orgId,
  toolName,
  toolInput,
  toolResult,
  toolMeta,
  onMessage,
  onUpdateModelContext,
  onTeardown,
}: MCPAppRendererProps) {
  const client = useMCPClient({ connectionId, orgId });

  const toolDef: Tool = {
    name: toolName,
    inputSchema: { type: "object" },
    ...(toolMeta != null && { _meta: toolMeta }),
  };

  return (
    <div className="mt-2 border border-border/75 rounded-lg overflow-hidden p-3">
      <MCPAppIframeRenderer
        resourceURI={uiResourceUri}
        toolInfo={{ tool: toolDef }}
        toolInput={normalizeToolInput(toolInput)}
        toolResult={normalizeToolResult(toolResult)}
        client={client}
        onMessage={onMessage}
        onUpdateModelContext={onUpdateModelContext}
        onTeardown={onTeardown}
      />
    </div>
  );
}

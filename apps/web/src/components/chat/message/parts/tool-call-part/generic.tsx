"use client";

import { useT } from "@/i18n/use-t.ts";
import { contentBlocksToTiptapDoc } from "@decocms/shared/mcp-apps/content-blocks";
import { MCPAppRenderer as MCPAppIframeRenderer } from "@/mcp-apps/mcp-app-renderer";
import { getUIResourceUri } from "@decocms/shared/mcp-apps/types";
import {
  useOptionalChatStream,
  useOptionalChatPrefs,
  useOptionalChatTask,
} from "@/components/chat/context.tsx";
import { useTaskExpandedTools } from "@/hooks/use-task-expanded-tools";
import { formatBytes } from "@/lib/format-bytes";
import { formatPinnedViewTabId } from "@/layouts/main-panel-tabs/tab-id";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";

import type { ToolDefinition } from "@/sdk";
import { useMCPClient, useProjectContext } from "@/sdk";
import {
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import { stripMcpServerPrefix } from "@/lib/tool-namespace";
import { useToolDefinitionLookup } from "@/hooks/use-tool-definition-lookup";
import { toTitleCase } from "./utils.tsx";
import type {
  McpUiDisplayMode,
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
import { TOOL_DISPLAY_MAP } from "./tool-display-map.ts";
import { BashWaitSummary } from "./bash-wait.tsx";
import { parseSleepMs } from "./bash-sleep.ts";
import { toEpochMs } from "@/lib/format-time.ts";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type React from "react";
import { Suspense } from "react";
import { ErrorBoundary } from "@/components/error-boundary.tsx";
import { usePanelActions } from "@/layouts/shell-layout";

import { getToolPartErrorText, safeStringifyFormatted } from "../utils.ts";
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
  /** UTF-8 byte length of the JSON-serialized tool result. */
  outputBytes?: number;
  /** Whether this part belongs to the last (most recent) assistant message */
  isLastMessage?: boolean;
  /** Tool _meta from data-tool-metadata part */
  toolMeta?: ToolDefinition["_meta"];
}

/**
 * Read the part's own persisted `created_at` (epoch ms). `foldParts` stamps it
 * onto each part on the v2 read path — it's the only per-part timestamp the
 * client gets, and it anchors the `bash` `sleep` countdown to when that
 * specific call fired (correct across reload / late attach). Null while the
 * turn is still in-flight (parts not yet folded from storage).
 */
function partCreatedAtMs(part: unknown): number | null {
  const raw =
    part && typeof part === "object" && "created_at" in part
      ? (part as { created_at?: unknown }).created_at
      : undefined;
  return typeof raw === "string" || raw instanceof Date ? toEpochMs(raw) : null;
}

/** Effective bash timeout (ms) the daemon enforces — mirrors BashInputSchema. */
function bashTimeoutMs(input: unknown): number {
  const t =
    input && typeof input === "object" && "timeout" in input
      ? (input as { timeout?: unknown }).timeout
      : undefined;
  return Math.min(typeof t === "number" ? t : 30_000, 120_000);
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

function formatLatency(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

function LatencyBytesBadge({
  latency,
  outputBytes,
}: {
  latency?: number;
  outputBytes?: number;
}) {
  const hasLatency = typeof latency === "number" && latency > 0;
  const hasBytes = typeof outputBytes === "number" && outputBytes >= 0;
  if (!hasLatency && !hasBytes) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-mono tabular-nums text-muted-foreground/60 px-1 leading-none">
      {hasLatency && <span>{formatLatency(latency!)}</span>}
      {hasLatency && hasBytes && (
        <span className="text-muted-foreground/30">·</span>
      )}
      {hasBytes && <span>{formatBytes(outputBytes!)}</span>}
    </span>
  );
}

/** Returns a short status hint shown on the summary line */
function getSummary(
  state: string,
  output?: unknown,
  errorText?: string,
  t?: ReturnType<typeof useT>,
): string {
  // ponytail: t param optional; used only for async/reactive state labels
  switch (state) {
    case "input-streaming":
    case "input-available":
      return t ? t("chat.generic.preparing") : "Preparing...";
    case "approval-requested":
      return t
        ? t("chat.generic.waitingForApproval")
        : "Waiting for your approval";
    case "output-denied":
      return t ? t("chat.generic.cancelled") : "Cancelled";
    case "output-error":
      return errorText ?? (t ? t("chat.generic.failed") : "Failed");
    case "output-available": {
      // Try to surface a concise result snippet
      if (output == null) return t ? t("chat.generic.done") : "Done";
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
  outputBytes,
  isLastMessage,
  toolMeta,
}: GenericToolCallPartProps) {
  const t = useT();
  // Extract tool name with proper dynamic-tool handling
  const rawToolName =
    "toolName" in part && typeof part.toolName === "string"
      ? part.toolName
      : part.type === "dynamic-tool"
        ? t("chat.generic.dynamicTool")
        : part.type.replace("tool-", "") || "Tool";
  // Strip mcp__<server>__ prefix (e.g. mcp__cms__conn-abc_hello → conn-abc_hello)
  const mcpStrippedName = stripMcpServerPrefix(rawToolName);

  const chatStream = useOptionalChatStream();
  const chatPrefs = useOptionalChatPrefs();
  const { org } = useProjectContext();

  const { openSidePanel } = usePanelActions();
  // Optional: the tool-call part is also rendered read-only in the Monitor
  // threads view, which has no ChatContextProvider / ThreadManagerProvider.
  const taskId = useOptionalChatTask()?.taskId ?? null;
  const { addOrReplaceEager } = useTaskExpandedTools(taskId);
  const navigate = useNavigate();

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
    org.slug,
  );
  const meta = toolDef?._meta ?? toolMeta;
  const gatewayClientId = getGatewayClientId(meta);
  const toolName = stripToolNamespace(mcpStrippedName, gatewayClientId);
  const toolDisplay = TOOL_DISPLAY_MAP[toolName];
  const friendlyName =
    toolDef?.title ?? toolDisplay?.label ?? toTitleCase(toolName);
  const uiResourceUri = getUIResourceUri(meta);

  const hasMCPApp = !!uiResourceUri && part.state === "output-available";
  const sourceId = connectionId ? `${connectionId}:${rawToolName}` : null;
  const isDestructive = !!annotations?.destructiveHint;
  const canOpenInPanel =
    hasMCPApp && !!connectionId && !isDestructive && !!taskId;

  const handleOpenInPanel = () => {
    if (!connectionId) return;
    const args =
      "input" in part && part.input && typeof part.input === "object"
        ? (part.input as Record<string, unknown>)
        : {};
    addOrReplaceEager({
      toolName: rawToolName,
      appId: connectionId,
      args,
    });
    // Use the self-describing `app:<connId>:<toolName>` tab id so the
    // main panel can render from the URL alone, without waiting on the
    // thread metadata to fetch.
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        main: formatPinnedViewTabId(connectionId, rawToolName),
      }),
      replace: true,
    });
  };

  const handleRequestDisplayMode = (
    mode: McpUiDisplayMode,
  ): McpUiDisplayMode => {
    if (mode === "fullscreen" && canOpenInPanel) {
      handleOpenInPanel();
      return "fullscreen";
    }
    return "inline";
  };

  const handleAppMessage = (params: McpUiMessageRequest["params"]) => {
    const doc = contentBlocksToTiptapDoc(params.content);
    if (doc.content.length > 0) {
      openSidePanel("chat");
      chatStream?.sendMessage(doc);
    }
  };

  // Compute state-dependent props
  // Cancelled = explicitly denied OR stale approval (conversation moved on)
  const isStaleApproval =
    part.state === "approval-requested" && isLastMessage === false;
  const isCancelled = part.state === "output-denied" || isStaleApproval;

  // MCP tools can return isError:true inside a successful output-available response
  const isOutputError =
    part.state === "output-available" &&
    typeof part.output === "object" &&
    part.output != null &&
    "isError" in (part.output as object) &&
    (part.output as Record<string, unknown>).isError === true;

  // Approval-requested parts render as idle inline (approval UI is in the highlight above input)
  const rawState = getEffectiveState(part.state);
  const effectiveState =
    isStaleApproval || rawState === "approval"
      ? "idle"
      : isOutputError
        ? "error"
        : rawState;

  // Error text (used in summary and detail)
  const errorText =
    part.state === "output-error" ? getToolPartErrorText(part) : undefined;

  // While a `bash` `sleep` is still running, replace the generic "Preparing…"
  // with a live countdown. Duration is parsed from the command (capped at the
  // daemon timeout, since a longer sleep is killed there); the countdown anchors
  // on this part's own persisted `created_at` (when the call fired) so the
  // remaining time stays correct across reload / late attach.
  const sleepCommand =
    toolName === "bash" &&
    effectiveState === "loading" &&
    part.input &&
    typeof part.input === "object" &&
    typeof (part.input as { command?: unknown }).command === "string"
      ? (part.input as { command: string }).command
      : null;
  const sleepMs = sleepCommand !== null ? parseSleepMs(sleepCommand) : null;
  const sleepDurationMs =
    sleepMs !== null ? Math.min(sleepMs, bashTimeoutMs(part.input)) : null;
  const toolCallId = "toolCallId" in part ? part.toolCallId : "";

  const summary =
    sleepDurationMs !== null ? (
      <BashWaitSummary
        toolCallId={toolCallId}
        durationMs={sleepDurationMs}
        anchorMs={partCreatedAtMs(part)}
      />
    ) : isStaleApproval ? (
      t("chat.generic.cancelled")
    ) : isOutputError ? (
      t("chat.generic.failed")
    ) : (
      getSummary(part.state, part.output, errorText, t)
    );

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
        icon={(() => {
          if (isCancelled) return <XClose />;
          if (hasMCPApp)
            return <LayersTwo01 className="size-4 text-muted-foreground" />;
          const MappedIcon = toolDisplay?.icon;
          if (MappedIcon)
            return <MappedIcon className="size-4 text-muted-foreground" />;
          return <Atom02 className="size-4 text-muted-foreground" />;
        })()}
        iconDestructive={isCancelled}
        trailing={
          <>
            <AnnotationBadges annotations={annotations} toolMeta={toolMeta} />
            <LatencyBytesBadge latency={latency} outputBytes={outputBytes} />
          </>
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
            {t("chat.generic.openInPanel")}
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
                  {t("chat.generic.failedToLoad", { toolName: friendlyName })}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5 shrink-0"
                  onClick={resetError}
                >
                  <RefreshCw01 className="size-3.5" />
                  {t("chat.generic.retry")}
                </Button>
              </div>
            )}
          >
            <Suspense
              fallback={
                <div className="mt-2 flex items-center justify-center h-12 border border-border/75 rounded-lg overflow-hidden p-3">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <div className="size-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm">
                      {t("chat.generic.loadingApp")}
                    </span>
                  </div>
                </div>
              }
            >
              <MCPAppRenderer
                uiResourceUri={uiResourceUri}
                connectionId={connectionId}
                orgId={org.id}
                orgSlug={org.slug}
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
                onRequestDisplayMode={
                  canOpenInPanel ? handleRequestDisplayMode : undefined
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
  orgSlug: string;
  toolName: string;
  toolInput: unknown;
  toolResult: unknown;
  toolMeta?: Record<string, unknown>;
  onMessage?: (params: McpUiMessageRequest["params"]) => void;
  onUpdateModelContext?: (
    params: McpUiUpdateModelContextRequest["params"],
  ) => void;
  onTeardown?: () => void;
  onRequestDisplayMode?: (
    mode: McpUiDisplayMode,
  ) => McpUiDisplayMode | Promise<McpUiDisplayMode>;
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
  orgSlug,
  toolName,
  toolInput,
  toolResult,
  toolMeta,
  onMessage,
  onUpdateModelContext,
  onTeardown,
  onRequestDisplayMode,
}: MCPAppRendererProps) {
  const client = useMCPClient({ connectionId, orgId, orgSlug });

  const toolDef: Tool = {
    name: toolName,
    inputSchema: { type: "object" },
    ...(toolMeta != null && { _meta: toolMeta }),
  };

  return (
    <div className="mt-2 border border-border/75 rounded-lg overflow-hidden p-3">
      <MCPAppIframeRenderer
        resourceURI={uiResourceUri}
        orgId={orgId}
        toolInfo={{ tool: toolDef }}
        toolInput={normalizeToolInput(toolInput)}
        toolResult={normalizeToolResult(toolResult)}
        client={client}
        onMessage={onMessage}
        onUpdateModelContext={onUpdateModelContext}
        onTeardown={onTeardown}
        onRequestDisplayMode={onRequestDisplayMode}
      />
    </div>
  );
}

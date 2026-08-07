import { cn } from "@decocms/ui/lib/utils.ts";
import { useMCPReadResource, useUiResourceHtml } from "@/sdk";
import type {
  McpUiDisplayMode,
  McpUiHostContext,
  McpUiMessageRequest,
  McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { injectCSP } from "@decocms/shared/mcp-apps/csp-injector";
import type { McpUiResourceCsp } from "@decocms/shared/mcp-apps/types";
import { useAppBridge } from "./use-app-bridge.ts";
import { track } from "../lib/posthog-client";
import { usePreferences } from "../hooks/use-preferences.ts";

// Module-level dedup so a given MCP app resource fires `mcp_app_opened` at
// most once per page session. Different resources still fire their own events.
const openedMcpApps = new Set<string>();

// ---------------------------------------------------------------------------
// useResourceHtml — client-side CSP injection for the JSON-RPC read path
// ---------------------------------------------------------------------------

type ReadResourceData = {
  contents?: Array<{
    text?: string;
    _meta?: { ui?: { csp?: McpUiResourceCsp } };
  }>;
};

function useResourceHtml(data: ReadResourceData | undefined): string | null {
  const content = data?.contents?.[0];
  if (!content || !("text" in content) || !content.text) return null;
  return injectCSP(content.text, {
    resourceCsp: (
      content._meta as { ui?: { csp?: McpUiResourceCsp } } | undefined
    )?.ui?.csp,
  });
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MCPAppRendererProps {
  resourceURI: string;
  orgId?: string;
  /**
   * When both `orgSlug` and `connectionId` are provided, the HTML is fetched
   * via the cacheable GET endpoint (browser HTTP-caches it, ETag-revalidated,
   * CSP injected server-side). Otherwise it falls back to the JSON-RPC
   * `resources/read` path via `client`.
   */
  orgSlug?: string;
  connectionId?: string;
  toolInfo?: McpUiHostContext["toolInfo"];
  toolInput?: Record<string, unknown>;
  toolResult?: CallToolResult;
  displayMode?: McpUiDisplayMode;
  minHeight?: number;
  maxHeight?: number;
  client: Client;
  onMessage?: (params: McpUiMessageRequest["params"]) => void;
  onUpdateModelContext?: (
    params: McpUiUpdateModelContextRequest["params"],
  ) => void;
  onTeardown?: () => void;
  onRequestDisplayMode?: (
    mode: McpUiDisplayMode,
  ) => McpUiDisplayMode | Promise<McpUiDisplayMode>;
  className?: string;
}

// ---------------------------------------------------------------------------
// Frame — shared presentation + app bridge (identical for both data paths)
// ---------------------------------------------------------------------------

function MCPAppFrame({
  html,
  uri,
  orgId,
  toolInfo,
  toolInput,
  toolResult,
  displayMode = "inline",
  minHeight = 150,
  maxHeight = 600,
  client,
  onMessage,
  onUpdateModelContext,
  onTeardown,
  onRequestDisplayMode,
  className,
}: Omit<MCPAppRendererProps, "resourceURI" | "orgSlug" | "connectionId"> & {
  html: string | null;
  uri: string;
}) {
  // Fire mcp_app_opened once per (page session × resource URI) — render-time
  // dedupe via module Set.
  if (uri && !openedMcpApps.has(uri)) {
    openedMcpApps.add(uri);
    track("mcp_app_opened", {
      resource_uri: uri,
      display_mode: displayMode,
      tool_name: toolInfo?.tool?.name ?? null,
    });
  }

  // Feed Studio's UI language into the iframe's host context so the embedded
  // MCP app localizes to match Studio (not the raw browser locale). Reactive:
  // changing the language re-renders here, useAppBridge detects the new locale
  // and pushes a host-context-changed notification to the live iframe.
  const [preferences] = usePreferences();

  const { height, isLoading, error, iframeRef } = useAppBridge({
    client,
    displayMode,
    minHeight,
    maxHeight,
    orgId,
    locale: preferences.language,
    toolInfo,
    toolInput,
    toolResult,
    onMessage,
    onUpdateModelContext,
    onTeardown,
    onRequestDisplayMode,
  });

  if (!html) return null;

  if (error) {
    return (
      <div
        className={cn(
          "flex items-center justify-center p-4 text-destructive bg-destructive/10 rounded-lg",
          className,
        )}
      >
        <span className="text-sm">{error}</span>
      </div>
    );
  }

  const toolName = toolInfo?.tool.name;

  return (
    <div
      className={cn("relative w-full overflow-hidden rounded-lg", className)}
      style={
        displayMode !== "fullscreen" ? { height: `${height}px` } : undefined
      }
    >
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
          <div className="flex items-center gap-2 text-muted-foreground">
            <div className="size-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
            <span className="text-sm">Loading app...</span>
          </div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        srcDoc={html}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
        className={cn("w-full h-full border-0", isLoading && "invisible")}
        title={`MCP App: ${toolName ?? uri}`}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data paths
// ---------------------------------------------------------------------------

// Cacheable GET path: browser HTTP-caches the (server-CSP-injected) HTML.
function MCPAppRendererViaGet({
  resourceURI,
  orgSlug,
  connectionId,
  ...frameProps
}: MCPAppRendererProps & { orgSlug: string; connectionId: string }) {
  const html = useUiResourceHtml({
    orgSlug,
    connectionId,
    uri: resourceURI,
    staleTime: 30_000,
  });
  return <MCPAppFrame html={html.data} uri={resourceURI} {...frameProps} />;
}

// JSON-RPC `resources/read` path (CSP injected client-side). Used wherever the
// caller can't supply orgSlug + connectionId.
function MCPAppRendererViaClient({
  resourceURI,
  ...frameProps
}: MCPAppRendererProps) {
  const { data } = useMCPReadResource({
    client: frameProps.client,
    uri: resourceURI,
    staleTime: 30_000,
  });
  const html = useResourceHtml(data);
  return <MCPAppFrame html={html} uri={resourceURI} {...frameProps} />;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MCPAppRenderer(props: MCPAppRendererProps) {
  if (props.orgSlug && props.connectionId) {
    return (
      <MCPAppRendererViaGet
        {...props}
        orgSlug={props.orgSlug}
        connectionId={props.connectionId}
      />
    );
  }
  return <MCPAppRendererViaClient {...props} />;
}

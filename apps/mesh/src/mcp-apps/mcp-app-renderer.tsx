import { cn } from "@deco/ui/lib/utils.ts";
import { useMCPReadResource } from "@decocms/mesh-sdk";
import type {
  McpUiDisplayMode,
  McpUiHostContext,
  McpUiMessageRequest,
  McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { injectCSP } from "./csp-injector.ts";
import type { McpUiResourceCsp } from "./types.ts";
import { useAppBridge } from "./use-app-bridge.ts";

// ---------------------------------------------------------------------------
// useResourceHtml
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
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MCPAppRenderer({
  resourceURI: uri,
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
  className,
}: MCPAppRendererProps) {
  const { data } = useMCPReadResource({ client, uri, staleTime: 30_000 });
  const html = useResourceHtml(data);

  const { height, isLoading, error, iframeRef } = useAppBridge({
    client,
    displayMode,
    minHeight,
    maxHeight,
    toolInfo,
    toolInput,
    toolResult,
    onMessage,
    onUpdateModelContext,
    onTeardown,
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
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        className={cn("w-full h-full border-0", isLoading && "invisible")}
        title={`MCP App: ${toolName ?? uri}`}
      />
    </div>
  );
}

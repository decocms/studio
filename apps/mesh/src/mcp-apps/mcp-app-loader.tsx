"use client";

import { useMCPClient } from "@decocms/mesh-sdk";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { cn } from "@deco/ui/lib/utils.ts";
import { MCPAppRenderer } from "./mcp-app-renderer.tsx";
import { useUIResourceLoader } from "./use-ui-resource-loader.ts";

interface MCPAppLoaderProps {
  uiResourceUri: string;
  connectionId: string;
  orgId: string;
  toolName: string;
  toolInput: unknown;
  toolResult: unknown;
  minHeight?: number;
  maxHeight?: number;
  className?: string;
}

export function MCPAppLoader({
  uiResourceUri,
  connectionId,
  orgId,
  toolName,
  toolInput,
  toolResult,
  minHeight = 0,
  maxHeight = 600,
  className,
}: MCPAppLoaderProps) {
  // Use the connection client for tool calls (the virtual MCP / agent endpoint)
  const toolClient = useMCPClient({ connectionId, orgId });
  // Use the management MCP (null connectionId → /mcp) for reading resources,
  // since ui://mesh/* resources are registered on the management server
  const resourceClient = useMCPClient({ connectionId: null, orgId });

  const handleCallTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    const result = await toolClient.callTool({ name, arguments: args });
    return result as CallToolResult;
  };

  const handleReadResource = async (
    uri: string,
  ): Promise<ReadResourceResult> => {
    const result = await resourceClient.readResource({ uri });
    return result as ReadResourceResult;
  };

  const {
    html: appHtml,
    url: appUrl,
    loading,
    error,
  } = useUIResourceLoader(uiResourceUri, handleReadResource);

  if (loading) {
    return (
      <div
        className={cn("flex items-center justify-center", className)}
        style={{ height: `${Math.max(minHeight, 48)}px` }}
      >
        <div className="flex items-center gap-2 text-muted-foreground">
          <div className="size-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Loading app...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={cn(
          "flex items-center justify-center p-4 border border-destructive/30 rounded-lg bg-destructive/10",
          className,
        )}
      >
        <span className="text-sm text-destructive">{error}</span>
      </div>
    );
  }

  if (!appHtml && !appUrl) return null;

  return (
    <MCPAppRenderer
      html={appHtml ?? undefined}
      url={appUrl ?? undefined}
      uri={uiResourceUri}
      toolName={toolName}
      toolInput={toolInput as Record<string, unknown> | undefined}
      toolResult={toolResult as CallToolResult | undefined}
      minHeight={minHeight}
      maxHeight={maxHeight}
      callTool={handleCallTool}
      readResource={handleReadResource}
      className={className}
    />
  );
}

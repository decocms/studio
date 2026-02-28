"use client";

import { useState } from "react";
import { useMCPClient } from "@decocms/mesh-sdk";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { LayersTwo01, ChevronDown, ChevronUp } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { MCPAppRenderer } from "./mcp-app-renderer.tsx";
import { MCP_APP_DISPLAY_MODES } from "./types.ts";
import { useUIResourceLoader } from "./use-ui-resource-loader.ts";

interface MCPAppLoaderProps {
  uiResourceUri: string;
  connectionId: string;
  orgId: string;
  toolName: string;
  friendlyName?: string;
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
  friendlyName = toolName,
  toolInput,
  toolResult,
  minHeight = MCP_APP_DISPLAY_MODES.collapsed.minHeight,
  maxHeight = MCP_APP_DISPLAY_MODES.collapsed.maxHeight,
  className,
}: MCPAppLoaderProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const mcpClient = useMCPClient({ connectionId, orgId });

  const handleCallTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    const result = await mcpClient.callTool({ name, arguments: args });
    return result as CallToolResult;
  };

  const handleReadResource = async (
    uri: string,
  ): Promise<ReadResourceResult> => {
    const result = await mcpClient.readResource({ uri });
    return result as ReadResourceResult;
  };

  const {
    html: appHtml,
    loading,
    error,
  } = useUIResourceLoader(uiResourceUri, handleReadResource);

  const currentMode = isExpanded
    ? MCP_APP_DISPLAY_MODES.expanded
    : MCP_APP_DISPLAY_MODES.collapsed;
  const currentMinHeight = minHeight ?? currentMode.minHeight;
  const currentMaxHeight = maxHeight ?? currentMode.maxHeight;

  if (loading) {
    return (
      <div
        className={cn(
          "flex items-center justify-center border border-border rounded-lg",
          className,
        )}
        style={{ height: `${currentMinHeight}px` }}
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

  if (!appHtml) return null;

  return (
    <div className={cn(className)}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <LayersTwo01 className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">
            {friendlyName}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="p-1 rounded hover:bg-muted transition-colors"
        >
          {isExpanded ? (
            <ChevronUp className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 text-muted-foreground" />
          )}
        </button>
      </div>
      <MCPAppRenderer
        html={appHtml}
        uri={uiResourceUri}
        toolName={toolName}
        toolInput={toolInput as Record<string, unknown> | undefined}
        toolResult={toolResult as CallToolResult | undefined}
        minHeight={currentMinHeight}
        maxHeight={currentMaxHeight}
        callTool={handleCallTool}
        readResource={handleReadResource}
      />
    </div>
  );
}

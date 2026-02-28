import { cn } from "@deco/ui/lib/utils.ts";
import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpUiDisplayMode,
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiMessageRequest,
} from "@modelcontextprotocol/ext-apps";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MCPAppRendererProps {
  html?: string;
  url?: string;
  uri: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: CallToolResult;
  displayMode?: McpUiDisplayMode;
  minHeight?: number;
  maxHeight?: number;
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<CallToolResult>;
  readResource: (uri: string) => Promise<ReadResourceResult>;
  onMessage?: (params: McpUiMessageRequest["params"]) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOST_INFO = { name: "MCP Mesh", version: "1.0.0" } as const;

const HOST_CAPABILITIES: McpUiHostCapabilities = {
  openLinks: {},
  serverTools: {},
  serverResources: {},
  logging: {},
  message: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function buildHostContext(
  displayMode: McpUiDisplayMode,
  maxHeight?: number,
): McpUiHostContext {
  return {
    theme: detectTheme(),
    displayMode,
    availableDisplayModes: ["inline", "fullscreen"],
    ...(maxHeight != null && {
      containerDimensions: { maxHeight },
    }),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MCPAppRenderer({
  html,
  url,
  uri,
  toolName,
  toolInput,
  toolResult,
  displayMode = "inline",
  minHeight = 150,
  maxHeight = 600,
  callTool,
  readResource,
  onMessage,
  className,
}: MCPAppRendererProps) {
  const bridgeRef = useRef<AppBridge | null>(null);
  const disposedRef = useRef(false);
  const [height, setHeight] = useState(minHeight);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const prevBoundsRef = useRef({ minHeight, maxHeight });
  if (
    prevBoundsRef.current.minHeight !== minHeight ||
    prevBoundsRef.current.maxHeight !== maxHeight
  ) {
    prevBoundsRef.current = { minHeight, maxHeight };
    setHeight(minHeight);
  }

  // -----------------------------------------------------------------------
  // Iframe ref callback — sets up bridge on mount, tears down on unmount
  // -----------------------------------------------------------------------

  const handleIframeRef = (iframe: HTMLIFrameElement | null) => {
    if (bridgeRef.current) {
      disposedRef.current = true;
      bridgeRef.current.teardownResource({}).catch(() => {});
      bridgeRef.current.close();
      bridgeRef.current = null;
    }

    if (!iframe) return;

    disposedRef.current = false;

    try {
      const hostContext = buildHostContext(displayMode, maxHeight);

      const bridge = new AppBridge(null, HOST_INFO, HOST_CAPABILITIES, {
        hostContext,
      });
      bridgeRef.current = bridge;

      bridge.oncalltool = async (params) => {
        return callTool(params.name, params.arguments ?? {});
      };

      bridge.onreadresource = async (params) => {
        return readResource(params.uri);
      };

      bridge.onopenlink = async ({ url }) => {
        let parsed: URL | null = null;
        try {
          parsed = new URL(url);
        } catch {
          // invalid URL
        }
        if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
          throw new Error("Only http and https URLs are allowed");
        }
        window.open(url, "_blank", "noopener,noreferrer");
        return {};
      };

      if (onMessage) {
        bridge.onmessage = async (params) => {
          onMessage(params);
          return {};
        };
      }

      bridge.onsizechange = ({ height: h }) => {
        if (disposedRef.current) return;
        if (h != null) {
          setHeight(Math.max(minHeight, Math.min(maxHeight, h)));
        }
      };

      bridge.onloggingmessage = ({ level, data }) => {
        const method = level === "error" ? "error" : "debug";
        console[method](`[MCP App ${toolName ?? uri}]`, data);
      };

      bridge.oninitialized = () => {
        if (disposedRef.current) return;
        setIsLoading(false);
        if (toolInput != null) {
          bridge.sendToolInput({ arguments: toolInput });
        }
        if (toolResult != null) {
          bridge.sendToolResult(toolResult);
        }
      };

      if (!iframe.contentWindow) {
        console.warn("iframe contentWindow not yet available");
        return;
      }
      const transport = new PostMessageTransport(
        iframe.contentWindow,
        iframe.contentWindow,
      );
      bridge.connect(transport).catch((err: unknown) => {
        if (disposedRef.current) return;
        console.error("AppBridge connect failed:", err);
        setError(err instanceof Error ? err.message : "Connection failed");
        setIsLoading(false);
      });
    } catch (err) {
      console.error("Failed to create AppBridge:", err);
      setError(err instanceof Error ? err.message : "Unknown error");
      setIsLoading(false);
    }
  };

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  // Guard: nothing to render
  if (!html && !url) return null;

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

  return (
    <div
      className={cn("relative w-full overflow-hidden rounded-lg", className)}
      style={{ height: `${height}px` }}
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
        ref={handleIframeRef}
        src={url ?? undefined}
        srcDoc={html ?? undefined}
        // allow-same-origin is required for React module scripts loaded via src.
        // Safe: url is validated in useUIResourceLoader to be same-origin /_widgets/* only.
        sandbox={
          url
            ? "allow-scripts allow-same-origin allow-forms"
            : "allow-scripts allow-forms"
        }
        className={cn("w-full h-full border-0", isLoading && "invisible")}
        title={`MCP App: ${toolName ?? uri}`}
      />
    </div>
  );
}

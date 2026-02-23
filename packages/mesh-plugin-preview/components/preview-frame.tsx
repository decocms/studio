/**
 * Preview Frame — Running State
 *
 * Shows the dev server in an iframe with a toolbar for
 * refresh, open-in-tab, stop, and status indicator.
 * Starts the server if not already running.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Button } from "@deco/ui/components/button.tsx";
import {
  RefreshCw01,
  LinkExternal01,
  StopCircle,
  Loading01,
  AlertCircle,
} from "@untitledui/icons";
import type { PreviewConfig } from "../hooks/use-preview-config";
import { KEYS } from "../lib/query-keys";

interface PreviewFrameProps {
  client: Client;
  config: PreviewConfig;
  connectionId: string;
}

type ServerState = "checking" | "starting" | "polling" | "running" | "error";

/**
 * Extract text from an MCP tool result.
 * The local-dev bash tool returns JSON like { stdout, stderr, exitCode }
 * wrapped in a content array: [{ type: "text", text: "..." }].
 */
function extractText(
  result: { structuredContent?: unknown; content?: unknown } & Record<
    string,
    unknown
  >,
): string {
  const raw = result.content;
  if (Array.isArray(raw)) {
    const first = raw[0] as { text?: string } | undefined;
    return first?.text ?? "";
  }
  if (typeof raw === "string") return raw;
  return "";
}

/**
 * Check if the dev server is responding on the given port.
 */
async function checkServerRunning(
  client: Client,
  port: number,
): Promise<boolean> {
  try {
    const result = (await client.callTool({
      name: "bash",
      arguments: {
        cmd: `curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:${port}`,
      },
    })) as { structuredContent?: unknown; content?: unknown };

    const text = extractText(
      result as { structuredContent?: unknown; content?: unknown } & Record<
        string,
        unknown
      >,
    );

    // Parse the JSON response from bash tool: { stdout, stderr, exitCode }
    try {
      const parsed = JSON.parse(text) as {
        stdout?: string;
        exitCode?: number;
      };
      if (parsed.exitCode !== 0) return false;
      const code = parseInt(parsed.stdout?.trim() ?? "", 10);
      return code >= 200 && code < 500;
    } catch {
      // Fallback: try parsing as raw HTTP status code
      const code = parseInt(text.trim(), 10);
      return code >= 200 && code < 500;
    }
  } catch {
    return false;
  }
}

export default function PreviewFrame({
  client,
  config,
  connectionId,
}: PreviewFrameProps) {
  const [iframeKey, setIframeKey] = useState(0);
  const [serverState, setServerState] = useState<ServerState>("checking");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const iframeUrl = `http://localhost:${config.port}`;

  // Start the dev server in background
  const startServer = useMutation({
    mutationFn: async () => {
      setServerState("starting");
      await client.callTool({
        name: "bash",
        arguments: {
          cmd: `nohup ${config.command} > .deco/preview.log 2>&1 &`,
          timeout: 0,
        },
      });
    },
  });

  // Check if server is running on mount, start if needed, then poll until ready
  useQuery({
    queryKey: KEYS.serverCheck(connectionId, config.port),
    queryFn: async () => {
      // First check if already running
      const isRunning = await checkServerRunning(client, config.port);
      if (isRunning) {
        setServerState("running");
        return true;
      }

      // Not running — start the server
      if (serverState === "checking") {
        startServer.mutate();
      }

      // Poll until ready
      setServerState("polling");
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        const ready = await checkServerRunning(client, config.port);
        if (ready) {
          setServerState("running");
          return true;
        }
      }

      setServerState("error");
      setErrorMessage(`Server didn't respond on port ${config.port} after 60s`);
      return false;
    },
    staleTime: Infinity,
    retry: false,
  });

  // Stop the server
  const stopServer = useMutation({
    mutationFn: async () => {
      await client.callTool({
        name: "bash",
        arguments: {
          cmd: `lsof -ti :${config.port} | xargs kill 2>/dev/null || true`,
        },
      });
    },
    onSuccess: () => {
      setServerState("checking");
      queryClient.invalidateQueries({
        queryKey: KEYS.serverCheck(connectionId, config.port),
      });
    },
  });

  const handleRefresh = () => setIframeKey((k) => k + 1);

  const handleOpenInTab = () => {
    window.open(iframeUrl, "_blank");
  };

  // Loading / starting state
  if (serverState !== "running" && serverState !== "error") {
    const label =
      serverState === "checking"
        ? "Checking server..."
        : serverState === "starting"
          ? "Starting dev server..."
          : "Waiting for server to be ready...";

    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loading01 size={32} className="animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
    );
  }

  // Error state
  if (serverState === "error") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-8">
        <AlertCircle size={48} className="text-destructive" />
        <h3 className="text-lg font-medium">Failed to start server</h3>
        <p className="text-sm text-muted-foreground text-center">
          {errorMessage}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setServerState("checking");
            setErrorMessage(null);
            queryClient.invalidateQueries({
              queryKey: KEYS.serverCheck(connectionId, config.port),
            });
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  // Running — show iframe with toolbar
  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-background">
        {/* Status indicator */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="size-2 rounded-full bg-emerald-500 shrink-0" />
          <span className="text-sm text-muted-foreground truncate font-mono">
            localhost:{config.port}
          </span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="size-8 p-0"
            onClick={handleRefresh}
            title="Refresh"
          >
            <RefreshCw01 size={16} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="size-8 p-0"
            onClick={handleOpenInTab}
            title="Open in new tab"
          >
            <LinkExternal01 size={16} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="size-8 p-0 text-destructive hover:text-destructive"
            onClick={() => stopServer.mutate()}
            disabled={stopServer.isPending}
            title="Stop server"
          >
            {stopServer.isPending ? (
              <Loading01 size={16} className="animate-spin" />
            ) : (
              <StopCircle size={16} />
            )}
          </Button>
        </div>
      </div>

      {/* Iframe */}
      <iframe
        key={iframeKey}
        src={iframeUrl}
        className="w-full flex-1 border-0"
        title="Dev Server Preview"
      />
    </div>
  );
}

/**
 * Preview Frame — Running State
 *
 * Shows the dev server in an iframe with a toolbar for
 * refresh, open-in-tab, stop, and status indicator.
 * Starts the server if not already running.
 */

import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Button } from "@deco/ui/components/button.tsx";
import {
  RefreshCw01,
  LinkExternal01,
  Save01,
  StopCircle,
  Loading01,
  AlertCircle,
} from "@untitledui/icons";
import type { PreviewConfig } from "../hooks/use-preview-config";
import { KEYS } from "../lib/query-keys";

const GIT_PANEL_KEY = "mesh:git-panel:open";

/**
 * Toggle button for the git panel, communicates via localStorage.
 * The shell layout reads the same key to show/hide the panel.
 */
function SaveChangesToolbarButton({
  client,
  connectionId,
}: {
  client: Client;
  connectionId: string;
}) {
  const queryClient = useQueryClient();

  // Read git panel open state from the same TanStack Query key as useLocalStorage
  const panelQueryKey = ["localStorage", GIT_PANEL_KEY] as const;
  const { data: isOpen = false } = useQuery({
    queryKey: panelQueryKey,
    queryFn: () => {
      try {
        return JSON.parse(localStorage.getItem(GIT_PANEL_KEY) ?? "false");
      } catch {
        return false;
      }
    },
    initialData: () => {
      try {
        return JSON.parse(localStorage.getItem(GIT_PANEL_KEY) ?? "false");
      } catch {
        return false;
      }
    },
    staleTime: Infinity,
  });

  const { data: changeCount = 0 } = useQuery({
    queryKey: ["git", "status-count", connectionId],
    queryFn: async () => {
      const result = await client.callTool({
        name: "bash",
        arguments: { cmd: "git status --porcelain", timeout: 10000 },
      });
      const structured = result.structuredContent as
        | { stdout?: string }
        | undefined;
      const stdout = structured?.stdout ?? "";
      return stdout
        .trim()
        .split("\n")
        .filter((l: string) => Boolean(l.trim())).length;
    },
    staleTime: 10_000,
  });

  const toggle = () => {
    const next = !isOpen;
    localStorage.setItem(GIT_PANEL_KEY, JSON.stringify(next));
    queryClient.setQueryData(panelQueryKey, next);
    // Dispatch for any other listeners (e.g. cross-tab)
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: GIT_PANEL_KEY,
        newValue: JSON.stringify(next),
      }),
    );
  };

  return (
    <Button
      variant={isOpen ? "default" : "ghost"}
      size="sm"
      className="h-7 gap-1.5 ml-1 relative"
      onClick={toggle}
      title="Save changes"
    >
      <Save01 size={14} />
      <span className="text-xs">
        {changeCount > 0
          ? `${changeCount} ${changeCount === 1 ? "change" : "changes"}`
          : "Save"}
      </span>
      {changeCount > 0 && !isOpen && (
        <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-yellow-500 border-2 border-background" />
      )}
    </Button>
  );
}

interface PreviewFrameProps {
  client: Client;
  config: PreviewConfig;
  connectionId: string;
}

type ServerResult =
  | { status: "running" }
  | { status: "error"; message: string };

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
  const [path, setPath] = useState("/");
  const [isEditingUrl, setIsEditingUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const urlInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const startedRef = useRef(false);

  const iframeUrl = `http://localhost:${config.port}${path === "/" ? "" : path}`;

  // Check if server is running, start if needed, poll until ready.
  // Returns a ServerResult so the UI can be derived from query state alone.
  const serverQuery = useQuery({
    queryKey: KEYS.serverCheck(connectionId, config.port),
    queryFn: async (): Promise<ServerResult> => {
      // First check if already running
      const isRunning = await checkServerRunning(client, config.port);
      if (isRunning) {
        return { status: "running" };
      }

      // Not running — start the server (only once per mount cycle)
      if (!startedRef.current) {
        startedRef.current = true;
        await client.callTool({
          name: "bash",
          arguments: {
            cmd: `nohup ${config.command} > .deco/preview.log 2>&1 &`,
            timeout: 0,
          },
        });
      }

      // Poll until ready
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        const ready = await checkServerRunning(client, config.port);
        if (ready) {
          return { status: "running" };
        }
      }

      return {
        status: "error",
        message: `Server didn't respond on port ${config.port} after 60s`,
      };
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
      startedRef.current = false;
      queryClient.invalidateQueries({
        queryKey: KEYS.serverCheck(connectionId, config.port),
      });
    },
  });

  const handleRefresh = () => setIframeKey((k) => k + 1);

  const handleOpenInTab = () => {
    window.open(
      `http://localhost:${config.port}${path === "/" ? "" : path}`,
      "_blank",
    );
  };

  const handleRetry = () => {
    startedRef.current = false;
    queryClient.invalidateQueries({
      queryKey: KEYS.serverCheck(connectionId, config.port),
    });
  };

  // Derive UI state from query
  const result = serverQuery.data;
  const isLoading = serverQuery.isLoading || serverQuery.isFetching;
  const isError = result?.status === "error";
  const isRunning = result?.status === "running" && !isLoading;

  // Loading / starting state
  if (!isRunning && !isError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loading01 size={32} className="animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {isLoading
            ? "Checking server..."
            : "Waiting for server to be ready..."}
        </p>
      </div>
    );
  }

  // Error state
  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-8">
        <AlertCircle size={48} className="text-destructive" />
        <h3 className="text-lg font-medium">Failed to start server</h3>
        <p className="text-sm text-muted-foreground text-center">
          {result.message}
        </p>
        <Button variant="outline" onClick={handleRetry}>
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
        {/* Editable URL bar */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="size-2 rounded-full bg-emerald-500 shrink-0" />
          {isEditingUrl ? (
            <input
              ref={urlInputRef}
              type="text"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const value = urlDraft.trim();
                  // Parse "localhost:PORT/path" or just "/path"
                  const match = value.match(/^(?:localhost:(\d+))?(\/.*)?$/);
                  if (match) {
                    if (match[1]) {
                      // Port change is display-only (config.port drives the server)
                    }
                    setPath(match[2] || "/");
                    setIframeKey((k) => k + 1);
                  }
                  setIsEditingUrl(false);
                } else if (e.key === "Escape") {
                  setIsEditingUrl(false);
                }
              }}
              onBlur={() => setIsEditingUrl(false)}
              className="text-sm font-mono bg-transparent border-none outline-none text-foreground flex-1 min-w-0 p-0"
              spellCheck={false}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                const display = `localhost:${config.port}${path === "/" ? "/" : path}`;
                setUrlDraft(display);
                setIsEditingUrl(true);
                requestAnimationFrame(() => urlInputRef.current?.select());
              }}
              className="text-sm text-muted-foreground truncate font-mono hover:text-foreground transition-colors cursor-text text-left"
            >
              localhost:{config.port}
              {path !== "/" && path}
            </button>
          )}
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
          <SaveChangesToolbarButton
            client={client}
            connectionId={connectionId}
          />
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

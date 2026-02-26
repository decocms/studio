/**
 * Declare Layout — LayoutComponent
 *
 * Self-contained layout for the declare plugin.
 * Resolves the connection from plugin config, then:
 * 1. Read .planning/server.port (written by declare-cc serve)
 * 2. If file exists with a port → embed iframe at that port
 * 3. If .planning/ exists but no server.port → show "start server" state
 * 4. If no .planning/ at all → show init setup screen
 *
 * No heuristic port detection — each project's declare server writes
 * its own .planning/server.port file so there's no cross-project confusion.
 */

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useMCPClientOptional,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { Loading01 } from "@untitledui/icons";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Button } from "@deco/ui/components/button.tsx";
import { KEYS } from "../lib/query-keys";
import DeclareSetup from "./declare-setup";

type PluginConfigOutput = {
  config: {
    id: string;
    projectId: string;
    pluginId: string;
    connectionId: string | null;
    settings: Record<string, unknown> | null;
  } | null;
};

/** Extract text from an MCP tool result. */
function extractText(result: { content?: unknown }): string {
  const raw = result.content;
  if (Array.isArray(raw)) {
    const first = raw[0] as { text?: string } | undefined;
    return first?.text ?? "";
  }
  if (typeof raw === "string") return raw;
  return "";
}

/** Run a bash command via MCP, returning { stdout, exitCode }. */
async function runBash(
  client: Client,
  cmd: string,
): Promise<{ stdout: string; exitCode: number }> {
  try {
    const result = (await client.callTool({
      name: "bash",
      arguments: { cmd },
    })) as { structuredContent?: unknown; content?: unknown };

    const text = extractText(result as { content?: unknown });

    try {
      const parsed = JSON.parse(text) as {
        stdout?: string;
        exitCode?: number;
      };
      return {
        stdout: parsed.stdout ?? "",
        exitCode: parsed.exitCode ?? 1,
      };
    } catch {
      return { stdout: text.trim(), exitCode: 0 };
    }
  } catch {
    return { stdout: "", exitCode: 1 };
  }
}

/** Check if declare server is responding on the given port via /api/graph. */
async function checkServerRunning(
  client: Client,
  port: number,
): Promise<boolean> {
  const { stdout, exitCode } = await runBash(
    client,
    `curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:${port}/api/graph`,
  );
  if (exitCode !== 0) return false;
  const code = parseInt(stdout.trim(), 10);
  return code === 200;
}

type DetectResult =
  | { state: "has-port"; port: number }
  | { state: "has-planning" }
  | { state: "no-planning" };

/**
 * Detect declare state by reading files — no heuristic port probing.
 * .planning/server.port is the sole source of truth for the server port.
 */
async function detectDeclareState(client: Client): Promise<DetectResult> {
  // Try reading .planning/server.port first (most specific check)
  const { stdout: portText, exitCode: portExit } = await runBash(
    client,
    "cat .planning/server.port 2>/dev/null",
  );
  if (portExit === 0 && portText.trim()) {
    const port = parseInt(portText.trim(), 10);
    if (!Number.isNaN(port) && port > 0) {
      return { state: "has-port", port };
    }
  }

  // Check if .planning/ directory exists at all
  const { exitCode: dirExit } = await runBash(
    client,
    "test -d .planning && echo yes",
  );
  if (dirExit === 0) {
    return { state: "has-planning" };
  }

  return { state: "no-planning" };
}

export default function DeclareLayout() {
  const { org, project } = useProjectContext();
  const pluginId = "declare";

  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  // Fetch the plugin's connection config
  const { data: pluginConfig, isLoading: isLoadingConfig } = useQuery({
    queryKey: KEYS.pluginConfig(project.id ?? "", pluginId),
    queryFn: async () => {
      const result = (await selfClient.callTool({
        name: "PROJECT_PLUGIN_CONFIG_GET",
        arguments: { projectId: project.id, pluginId },
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as PluginConfigOutput;
    },
    enabled: !!project.id,
  });

  const configuredConnectionId = pluginConfig?.config?.connectionId ?? null;

  const connectionClient = useMCPClientOptional({
    connectionId: configuredConnectionId ?? undefined,
    orgId: org.id,
  });

  // Detect declare state from files
  const {
    data: declareState,
    isLoading: isDetecting,
    refetch: redetect,
  } = useQuery({
    queryKey: KEYS.planningCheck(configuredConnectionId ?? ""),
    queryFn: () => detectDeclareState(connectionClient!),
    enabled: !!connectionClient && !!configuredConnectionId,
    // Poll while waiting for server.port to appear (user may start server externally)
    refetchInterval: (query) => {
      const state = query.state.data;
      // Poll every 3s when .planning/ exists but no server.port yet
      if (state?.state === "has-planning") return 3_000;
      return false;
    },
  });

  // Loading state
  if (isLoadingConfig || isDetecting) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <Loading01
          size={32}
          className="animate-spin text-muted-foreground mb-4"
        />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  // No connection configured
  if (!configuredConnectionId || !connectionClient) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="text-center max-w-md">
          <h2 className="text-lg font-semibold mb-2">Declare Not Available</h2>
          <p className="text-sm text-muted-foreground">
            No local-dev connection is configured for this project. Add a
            local-dev project first.
          </p>
        </div>
      </div>
    );
  }

  // No .planning/ directory — show init setup
  if (!declareState || declareState.state === "no-planning") {
    return (
      <DeclareSetup
        client={connectionClient}
        onInitialized={() => redetect()}
      />
    );
  }

  // .planning/ exists but no server.port — show "start server" prompt
  if (declareState.state === "has-planning") {
    return (
      <DeclareStartServer
        client={connectionClient}
        onStarted={() => redetect()}
      />
    );
  }

  // server.port exists — show dashboard
  return (
    <DeclareDashboard
      client={connectionClient}
      connectionId={configuredConnectionId}
      port={declareState.port}
    />
  );
}

/**
 * Shown when .planning/ exists but no server.port file.
 * Offers to start the declare server.
 */
function DeclareStartServer({
  client,
  onStarted,
}: {
  client: Client;
  onStarted: () => void;
}) {
  const [isStarting, setIsStarting] = useState(false);

  const handleStart = async () => {
    setIsStarting(true);
    try {
      await client.callTool({
        name: "bash",
        arguments: {
          cmd: "nohup npx dcl serve > .planning/serve.log 2>&1 &",
          timeout: 0,
        },
      });
      // Poll for server.port to be written
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1_500));
        const { stdout, exitCode } = await runBash(
          client,
          "cat .planning/server.port 2>/dev/null",
        );
        if (exitCode === 0 && stdout.trim()) {
          onStarted();
          return;
        }
      }
      onStarted(); // try anyway
    } catch {
      setIsStarting(false);
    }
  };

  if (isStarting) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loading01 size={32} className="animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Starting declare server...
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <div className="flex flex-col items-center gap-6 max-w-sm w-full">
        <div className="text-center">
          <h2 className="text-lg font-semibold mb-1">
            Declare Server Not Running
          </h2>
          <p className="text-sm text-muted-foreground">
            The .planning/ directory exists but the declare server isn't
            running. Start it to view the dashboard.
          </p>
        </div>
        <Button onClick={handleStart}>Start Server</Button>
      </div>
    </div>
  );
}

/**
 * Declare Dashboard — embeds the declare-cc dashboard in an iframe.
 * Port comes from .planning/server.port (written by declare-cc serve).
 */
function DeclareDashboard({
  client,
  connectionId,
  port,
}: {
  client: Client;
  connectionId: string;
  port: number;
}) {
  const startedRef = useRef(false);
  const iframeUrl = `http://localhost:${port}`;

  // Verify the server is actually responding, start if needed
  const serverQuery = useQuery({
    queryKey: KEYS.serverCheck(connectionId, port),
    queryFn: async (): Promise<
      { status: "running" } | { status: "error"; message: string }
    > => {
      const isRunning = await checkServerRunning(client, port);
      if (isRunning) return { status: "running" };

      // server.port exists but server not responding — try starting it
      if (!startedRef.current) {
        startedRef.current = true;
        await client.callTool({
          name: "bash",
          arguments: {
            cmd: "nohup npx dcl serve > .planning/serve.log 2>&1 &",
            timeout: 0,
          },
        });
      }

      // Poll until ready
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        const ready = await checkServerRunning(client, port);
        if (ready) return { status: "running" };
      }

      return {
        status: "error",
        message: `Declare server didn't respond on port ${port} after 60s`,
      };
    },
    staleTime: Infinity,
    retry: false,
  });

  const result = serverQuery.data;
  const isLoading = serverQuery.isLoading || serverQuery.isFetching;
  const isError = result?.status === "error";
  const isRunning = result?.status === "running" && !isLoading;

  if (!isRunning && !isError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loading01 size={32} className="animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {isLoading
            ? "Checking declare server..."
            : "Starting declare server..."}
        </p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-8">
        <h3 className="text-lg font-medium">Failed to start declare server</h3>
        <p className="text-sm text-muted-foreground text-center">
          {result.message}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            startedRef.current = false;
            serverQuery.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <iframe
      src={iframeUrl}
      className="w-full h-full border-0"
      title="Declare Dashboard"
    />
  );
}

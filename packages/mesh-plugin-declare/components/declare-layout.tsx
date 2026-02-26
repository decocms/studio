/**
 * Declare Layout — LayoutComponent
 *
 * Self-contained layout for the declare plugin.
 * Resolves the connection from plugin config, then:
 * 1. Check if declare server is already running (heuristic, like preview)
 * 2. If running → embed iframe immediately
 * 3. If not running but .planning/ exists → start server, then embed
 * 4. If neither → show setup screen
 */

import { useRef } from "react";
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

const DEFAULT_PORT = 3847;

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

/** Check if declare server is responding on the given port. */
async function checkServerRunning(
  client: Client,
  port: number,
): Promise<boolean> {
  const { stdout, exitCode } = await runBash(
    client,
    `curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:${port}`,
  );
  if (exitCode !== 0) return false;
  const code = parseInt(stdout.trim(), 10);
  return code >= 200 && code < 500;
}

/** Check if .planning/ directory exists. */
async function checkPlanningExists(client: Client): Promise<boolean> {
  const { exitCode } = await runBash(client, "test -d .planning && echo yes");
  return exitCode === 0;
}

/** Read .planning/server.port for custom port, or return default. */
async function readServerPort(client: Client): Promise<number> {
  const { stdout, exitCode } = await runBash(
    client,
    "cat .planning/server.port 2>/dev/null",
  );
  if (exitCode === 0 && stdout.trim()) {
    const parsed = parseInt(stdout.trim(), 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_PORT;
}

type DetectResult =
  | { state: "running"; port: number }
  | { state: "stopped"; port: number }
  | { state: "no-planning" };

/**
 * Detect declare state: server running, .planning/ exists, or neither.
 */
async function detectDeclareState(client: Client): Promise<DetectResult> {
  // Check default port first (fast path)
  const runningOnDefault = await checkServerRunning(client, DEFAULT_PORT);
  if (runningOnDefault) return { state: "running", port: DEFAULT_PORT };

  // Check if .planning/ exists
  const hasPlanning = await checkPlanningExists(client);
  if (!hasPlanning) return { state: "no-planning" };

  // .planning/ exists — check for custom port
  const port = await readServerPort(client);

  // If custom port differs from default, check that too
  if (port !== DEFAULT_PORT) {
    const runningOnCustom = await checkServerRunning(client, port);
    if (runningOnCustom) return { state: "running", port };
  }

  return { state: "stopped", port };
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

  // Detect declare state: running server, .planning/ exists, or neither
  const {
    data: declareState,
    isLoading: isDetecting,
    refetch: redetect,
  } = useQuery({
    queryKey: KEYS.planningCheck(configuredConnectionId ?? ""),
    queryFn: () => detectDeclareState(connectionClient!),
    enabled: !!connectionClient && !!configuredConnectionId,
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

  // No .planning/ directory and no server running — show setup
  if (!declareState || declareState.state === "no-planning") {
    return (
      <DeclareSetup
        client={connectionClient}
        onInitialized={() => redetect()}
      />
    );
  }

  // Server already running or .planning/ exists — show dashboard
  return (
    <DeclareDashboard
      client={connectionClient}
      connectionId={configuredConnectionId}
      initialPort={declareState.port}
      alreadyRunning={declareState.state === "running"}
    />
  );
}

/**
 * Declare Dashboard — embeds the declare-cc dashboard in an iframe.
 * If not already running, starts the server first.
 */
function DeclareDashboard({
  client,
  connectionId,
  initialPort,
  alreadyRunning,
}: {
  client: Client;
  connectionId: string;
  initialPort: number;
  alreadyRunning: boolean;
}) {
  const startedRef = useRef(false);
  const port = initialPort;
  const iframeUrl = `http://localhost:${port}`;

  // Check if server is running, start if needed
  const serverQuery = useQuery({
    queryKey: KEYS.serverCheck(connectionId, port),
    queryFn: async (): Promise<
      { status: "running" } | { status: "error"; message: string }
    > => {
      // If we already know it's running, skip the check
      if (alreadyRunning && !startedRef.current) {
        return { status: "running" };
      }

      const isRunning = await checkServerRunning(client, port);
      if (isRunning) return { status: "running" };

      // Start server (only once per mount cycle)
      if (!startedRef.current) {
        startedRef.current = true;
        await client.callTool({
          name: "bash",
          arguments: {
            cmd: `nohup npx declare-cc serve > .planning/serve.log 2>&1 &`,
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

  // Loading / starting state
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

  // Error state
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

  // Running — show iframe fullscreen (no toolbar)
  return (
    <iframe
      src={iframeUrl}
      className="w-full h-full border-0"
      title="Declare Dashboard"
    />
  );
}

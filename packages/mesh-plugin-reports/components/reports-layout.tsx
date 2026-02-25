/**
 * Reports Layout
 *
 * Self-contained layout component for the reports plugin.
 * Handles connection filtering, plugin context setup, and renders
 * the reports UI directly (without relying on router Outlet).
 *
 * Uses URL search params (?reportId=...) so report URLs are copyable.
 */

import {
  type Binder,
  connectionImplementsBinding,
  type PluginContext,
  REPORTS_BINDING,
} from "@decocms/bindings";
import {
  SELF_MCP_ALIAS_ID,
  useConnections,
  useMCPClient,
  useMCPClientOptional,
  useProjectContext,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import { PluginContextProvider } from "@decocms/mesh-sdk/plugins";
import { useNavigate, useSearch } from "@decocms/bindings/plugin-router";
import { useQuery } from "@tanstack/react-query";
import { Loading01, Settings01 } from "@untitledui/icons";
import { KEYS } from "../lib/query-keys";
import PluginEmptyState from "./plugin-empty-state";
import PluginHeader from "./plugin-header";
import ReportDetail from "./report-detail";
import ReportsList from "./reports-list";

// ---------------------------------------------------------------------------
// Connection filtering
// ---------------------------------------------------------------------------

function filterConnectionsByBinding(
  connections: ConnectionEntity[] | undefined,
): ConnectionEntity[] {
  if (!connections) return [];
  return connections.filter((conn) =>
    connectionImplementsBinding(conn, REPORTS_BINDING),
  );
}

type PluginConfigOutput = {
  config: {
    id: string;
    projectId: string;
    pluginId: string;
    connectionId: string | null;
    settings: Record<string, unknown> | null;
  } | null;
};

// ---------------------------------------------------------------------------
// Main Layout
// ---------------------------------------------------------------------------

export default function ReportsLayout() {
  const { org, project } = useProjectContext();
  const search = useSearch({ strict: false }) as { reportId?: string };
  const navigate = useNavigate();
  const allConnections = useConnections();

  const reportId = search.reportId ?? null;
  const pluginId = "reports";

  const setReportId = (id: string | null) => {
    navigate({
      search: id ? { reportId: id } : {},
      replace: true,
    } as Parameters<typeof navigate>[0]);
  };

  // Fetch plugin config to get the configured connection
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

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

  // Filter connections by binding. Include Mesh MCP (Mesh database) - it has REPORTS_* tools.
  const bindingConnections = filterConnectionsByBinding(allConnections);
  const meshMcpId = WellKnownOrgMCPId.SELF(org.id);
  const meshMcp = allConnections?.find((c) => c.id === meshMcpId);
  const validConnections = [
    ...(meshMcp && !bindingConnections.some((c) => c.id === meshMcpId)
      ? [meshMcp]
      : []),
    ...bindingConnections,
  ];
  const configuredConnectionId = pluginConfig?.config?.connectionId;
  const configuredConnection = configuredConnectionId
    ? validConnections.find((c) => c.id === configuredConnectionId)
    : null;

  // MCP client for the configured connection
  const configuredClient = useMCPClientOptional({
    connectionId: configuredConnection?.id,
    orgId: org.id,
  });

  // Org context (always available)
  const orgContext = { id: org.id, slug: org.slug, name: org.name };

  // Loading state
  if (isLoadingConfig) {
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

  // No valid connections exist
  if (validConnections.length === 0) {
    return <PluginEmptyState />;
  }

  // No connection configured in project settings
  if (!configuredConnection) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 p-8">
        <div className="flex flex-col items-center gap-2 text-center max-w-md">
          <Settings01 size={48} className="text-muted-foreground mb-2" />
          <h2 className="text-lg font-semibold">Plugin Not Configured</h2>
          <p className="text-sm text-muted-foreground">
            This plugin requires a connection to be configured. Go to project
            settings to select which integration to use.
          </p>
        </div>
      </div>
    );
  }

  // Build plugin context
  const pluginContext: PluginContext<Binder> = {
    connectionId: configuredConnection.id,
    connection: {
      id: configuredConnection.id,
      title: configuredConnection.title,
      icon: configuredConnection.icon,
      description: configuredConnection.description,
      app_name: configuredConnection.app_name,
      app_id: configuredConnection.app_id,
      tools: configuredConnection.tools,
      metadata: configuredConnection.metadata,
    },
    toolCaller: ((toolName: string, args: unknown) =>
      configuredClient
        ? configuredClient
            .callTool({
              name: toolName,
              arguments: args as Record<string, unknown>,
            })
            .then((result) => result.structuredContent ?? result)
        : Promise.reject(
            new Error("MCP client is not available"),
          )) as PluginContext<Binder>["toolCaller"],
    org: orgContext,
    session: null,
  };

  return (
    <PluginContextProvider value={pluginContext}>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center px-6 py-3 border-b border-border">
          <PluginHeader
            connections={[pluginContext.connection]}
            selectedConnectionId={configuredConnection.id}
            onConnectionChange={() => {}}
          />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {reportId ? (
            <ReportDetail
              reportId={reportId}
              onBack={() => setReportId(null)}
            />
          ) : (
            <ReportsList onSelectReport={setReportId} />
          )}
        </div>
      </div>
    </PluginContextProvider>
  );
}

/**
 * Ranking Layout
 *
 * Self-contained layout for the collection reorder ranking plugin.
 * Uses the same Reports MCP connection as the reports plugin.
 * Uses URL search params (?reportId=...) for copyable report URLs.
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
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { PluginContextProvider } from "@decocms/mesh-sdk/plugins";
import { useNavigate, useSearch } from "@decocms/bindings/plugin-router";
import { useQuery } from "@tanstack/react-query";
import { Loading01, Settings01 } from "@untitledui/icons";
import { KEYS } from "../lib/query-keys";
import RankingEmptyState from "./ranking-empty-state";
import RankingDetail from "./ranking-detail";
import RankingsList from "./rankings-list";

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

export default function RankingLayout() {
  const { org, project } = useProjectContext();
  const search = useSearch({ strict: false }) as { reportId?: string };
  const navigate = useNavigate();
  const allConnections = useConnections();

  const reportId = search.reportId ?? null;
  const pluginId = "collection-reorder-ranking";

  const setReportId = (id: string | null) => {
    navigate({
      search: id ? { reportId: id } : {},
      replace: true,
    } as Parameters<typeof navigate>[0]);
  };

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

  const validConnections = filterConnectionsByBinding(allConnections);
  const configuredConnectionId = pluginConfig?.config?.connectionId;
  const configuredConnection = configuredConnectionId
    ? validConnections.find((c) => c.id === configuredConnectionId)
    : null;

  const configuredClient = useMCPClientOptional({
    connectionId: configuredConnection?.id,
    orgId: org.id,
  });

  const orgContext = { id: org.id, slug: org.slug, name: org.name };

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

  if (validConnections.length === 0) {
    return <RankingEmptyState />;
  }

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
        <div className="flex-1 overflow-hidden">
          {reportId ? (
            <RankingDetail
              reportId={reportId}
              onBack={() => setReportId(null)}
            />
          ) : (
            <RankingsList onSelectReport={setReportId} />
          )}
        </div>
      </div>
    </PluginContextProvider>
  );
}

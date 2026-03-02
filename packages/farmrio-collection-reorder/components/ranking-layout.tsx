/**
 * Ranking Layout
 *
 * Self-contained layout for the collection reorder ranking plugin.
 * Collections are loaded directly from the MCP via collection_list.
 * An optional VTEX connection handles the reorder apply action.
 * Uses URL search params (?collectionId=...&reportId=...) for copyable URLs.
 */

import {
  FARMRIO_REORDER_BINDING,
  VTEX_REORDER_COLLECTION_BINDING,
  connectionImplementsBinding,
  type PluginContext,
  type FarmrioCollectionItem,
} from "@decocms/bindings";
import { useNavigate, useSearch } from "@decocms/bindings/plugin-router";
import {
  SELF_MCP_ALIAS_ID,
  type ConnectionEntity,
  useConnections,
  useMCPClient,
  useMCPClientOptional,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { PluginContextProvider } from "@decocms/mesh-sdk/plugins";
import { Button } from "@deco/ui/components/button.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loading01, Settings01 } from "@untitledui/icons";
import { KEYS } from "../lib/query-keys";
import CollectionsList from "./collections-list";
import RankingDetail from "./ranking-detail";
import RankingEmptyState from "./ranking-empty-state";
import RankingsList from "./rankings-list";
import { VtexConnectionProvider } from "./vtex-connection-context";

function filterConnectionsByBinding(
  connections: ConnectionEntity[] | undefined,
): ConnectionEntity[] {
  if (!connections) return [];
  return connections.filter((conn) =>
    connectionImplementsBinding(conn, FARMRIO_REORDER_BINDING),
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

type SearchParams = {
  collectionId?: string;
  reportId?: string;
};

export default function RankingLayout() {
  const { org, project } = useProjectContext();
  const search = useSearch({ strict: false }) as SearchParams;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const allConnections = useConnections();

  const collectionId = search.collectionId ?? null;
  const reportId = search.reportId ?? null;
  const pluginId = "collection-reorder-ranking";

  const setCollectionId = (id: string | null) => {
    navigate({
      search: id ? { collectionId: id } : {},
      replace: true,
    } as unknown as Parameters<typeof navigate>[0]);
  };

  const setReportId = (id: number | null) => {
    if (!collectionId) return;
    navigate({
      search: id ? { collectionId, reportId: String(id) } : { collectionId },
      replace: true,
    } as unknown as Parameters<typeof navigate>[0]);
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

  const settings =
    pluginConfig?.config?.settings &&
    typeof pluginConfig.config.settings === "object"
      ? (pluginConfig.config.settings as Record<string, unknown>)
      : null;

  const configuredVtexConnectionId =
    typeof settings?.vtexConnectionId === "string"
      ? settings.vtexConnectionId
      : null;
  const configuredVtexConnection = configuredVtexConnectionId
    ? (allConnections?.find(
        (conn) =>
          conn.id === configuredVtexConnectionId &&
          connectionImplementsBinding(conn, VTEX_REORDER_COLLECTION_BINDING),
      ) ?? null)
    : null;

  const configuredClient = useMCPClientOptional({
    connectionId: configuredConnection?.id,
    orgId: org.id,
  });
  const configuredVtexClient = useMCPClientOptional({
    connectionId: configuredVtexConnection?.id,
    orgId: org.id,
  });

  const { data: collectionsData, isLoading: isLoadingCollections } = useQuery({
    queryKey: KEYS.collectionsList(configuredConnection?.id ?? ""),
    queryFn: async (): Promise<FarmrioCollectionItem[]> => {
      const result = (await configuredClient!.callTool({
        name: "collection_list",
        arguments: { isEnabled: true, limit: 200 },
      })) as { structuredContent?: unknown };
      const data = (result.structuredContent ?? result) as {
        success: boolean;
        items?: FarmrioCollectionItem[];
      };
      return data.items ?? [];
    },
    enabled: !!configuredClient && !!configuredConnection,
  });

  const collections = collectionsData ?? [];
  const selectedCollection = collectionId
    ? (collections.find((c) => String(c.id) === collectionId) ?? null)
    : null;

  const orgContext = { id: org.id, slug: org.slug, name: org.name };

  const handleAddCollection = async (input: {
    title: string;
    farmCollectionId: string;
    decoCollectionId?: string;
  }) => {
    if (!configuredClient) throw new Error("MCP client not available");
    await configuredClient.callTool({
      name: "collection_create",
      arguments: {
        title: input.title,
        farmCollectionId: input.farmCollectionId,
        decoCollectionId: input.decoCollectionId,
      },
    });
    await queryClient.invalidateQueries({
      queryKey: KEYS.collectionsList(configuredConnection?.id ?? ""),
    });
  };

  const handleDeleteCollection = async (collection: FarmrioCollectionItem) => {
    if (collectionId === String(collection.id)) {
      setCollectionId(null);
    }
    if (!configuredClient) throw new Error("MCP client not available");
    await configuredClient.callTool({
      name: "collection_update",
      arguments: {
        id: collection.id,
        farmCollectionId: collection.farmCollectionId,
        isEnabled: false,
      },
    });
    await queryClient.invalidateQueries({
      queryKey: KEYS.collectionsList(configuredConnection?.id ?? ""),
    });
  };

  const handleToggleCollection = async (
    collection: FarmrioCollectionItem,
    isEnabled: boolean,
  ) => {
    if (!configuredClient) throw new Error("MCP client not available");
    await configuredClient.callTool({
      name: "collection_update",
      arguments: {
        id: collection.id,
        farmCollectionId: collection.farmCollectionId,
        isEnabled,
      },
    });
    await queryClient.invalidateQueries({
      queryKey: KEYS.collectionsList(configuredConnection?.id ?? ""),
    });
  };

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
            This plugin requires a Farmrio reorder connection to be configured.
            Go to project settings to select which integration to use.
          </p>
        </div>
      </div>
    );
  }

  if (collectionId && !selectedCollection && !isLoadingCollections) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 p-8">
        <div className="flex flex-col items-center gap-2 text-center max-w-md">
          <h2 className="text-lg font-semibold">Collection Not Found</h2>
          <p className="text-sm text-muted-foreground">
            The selected collection was not found.
          </p>
        </div>
        <Button variant="outline" onClick={() => setCollectionId(null)}>
          Back to collections
        </Button>
      </div>
    );
  }

  const pluginContext: PluginContext<typeof FARMRIO_REORDER_BINDING> = {
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
          )) as PluginContext<typeof FARMRIO_REORDER_BINDING>["toolCaller"],
    org: orgContext,
    session: null,
  };

  const vtexContext = {
    connection: configuredVtexConnection
      ? {
          id: configuredVtexConnection.id,
          title: configuredVtexConnection.title,
          icon: configuredVtexConnection.icon,
          description: configuredVtexConnection.description,
          app_name: configuredVtexConnection.app_name,
          app_id: configuredVtexConnection.app_id,
          tools: configuredVtexConnection.tools,
          metadata: configuredVtexConnection.metadata,
        }
      : null,
    toolCaller: configuredVtexClient
      ? (
          toolName: "VTEX_REORDER_COLLECTION",
          args: { collectionId: string; productIds: string[] },
        ) =>
          configuredVtexClient
            .callTool({
              name: toolName,
              arguments: args,
            })
            .then((result) => result.structuredContent ?? result)
      : null,
  };

  return (
    <PluginContextProvider value={pluginContext}>
      <VtexConnectionProvider value={vtexContext}>
        <div className="flex flex-col h-full overflow-hidden">
          <div className="flex-1 overflow-hidden">
            {isLoadingCollections && !collectionId ? (
              <div className="flex flex-col items-center justify-center h-full">
                <Loading01
                  size={32}
                  className="animate-spin text-muted-foreground mb-4"
                />
                <p className="text-sm text-muted-foreground">
                  Loading collections...
                </p>
              </div>
            ) : !collectionId ? (
              <CollectionsList
                collections={collections}
                onSelectCollection={(c) => setCollectionId(String(c.id))}
                onAddCollection={handleAddCollection}
                onDeleteCollection={handleDeleteCollection}
                onToggleCollection={handleToggleCollection}
              />
            ) : reportId && selectedCollection ? (
              <RankingDetail
                reportId={Number(reportId)}
                collection={selectedCollection}
                onBack={() => setReportId(null)}
              />
            ) : selectedCollection ? (
              <RankingsList
                collection={selectedCollection}
                onBack={() => setCollectionId(null)}
                onSelectReport={(id) => setReportId(id)}
                onToggleCollection={handleToggleCollection}
              />
            ) : null}
          </div>
        </div>
      </VtexConnectionProvider>
    </PluginContextProvider>
  );
}

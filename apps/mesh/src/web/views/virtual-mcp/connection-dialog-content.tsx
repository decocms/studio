import { getConnectionSlug } from "@/shared/utils/connection-slug";
import { groupConnections } from "@/shared/utils/group-connections";
import { CollectionTabs } from "@/web/components/collections/collection-tabs.tsx";
import { ConnectionCard } from "@/web/components/connections/connection-card.tsx";
import type { RegistryItem } from "@/web/components/store/types";
import { useInfiniteScroll } from "@/web/hooks/use-infinite-scroll";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { KEYS } from "@/web/lib/query-keys";
import { getRegistryItemAppName } from "@/web/utils/extract-connection-data";
import { getGitHubAvatarUrl } from "@deco/ui/lib/github.ts";
import { useEnabledRegistries } from "@/web/hooks/use-enabled-registries";
import { useMergedStoreDiscovery } from "@/web/hooks/use-merged-store-discovery";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  type ConnectionEntity,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { CollectionListOutput } from "@decocms/bindings/collections";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import {
  Check,
  CheckVerified02,
  Container,
  Loading01,
  Plus,
} from "@untitledui/icons";
import { useDeferredValue } from "react";
import { track } from "@/web/lib/posthog-client";
import { useT } from "@/web/i18n/use-t.ts";

type ConnectionDialogMode = "add" | "browse";

type ConnectionTab = "all" | "connected";

export function ConnectionDialogContent({
  mode = "add",
  agentId,
  addedConnectionIds,
  onAdd,
  onCloneAndAdd,
  onConnectAndAdd,
  connectingItemId,
  search,
  onCreateConnection,
  onBrowseNavigate,
  defaultTab = "connected",
}: {
  mode?: ConnectionDialogMode;
  agentId?: string;
  addedConnectionIds: Set<string>;
  onAdd: (connectionId: string) => void;
  onCloneAndAdd: (base: ConnectionEntity) => void;
  onConnectAndAdd: (item: RegistryItem) => void;
  connectingItemId: string | null;
  search: string;
  onCreateConnection: () => void;
  onBrowseNavigate?: (slug: string) => void;
  defaultTab?: "all" | "connected";
}) {
  const t = useT();
  const { org } = useProjectContext();
  const deferredSearch = useDeferredValue(search);
  const isSearchStale = search !== deferredSearch;
  const searchLower = deferredSearch.trim().toLowerCase();

  const [activeTab, setActiveTab] = useLocalStorage<ConnectionTab>(
    LOCALSTORAGE_KEYS.connectionsTab(org.slug) +
      (defaultTab === "all" ? ":home-modal" : ":agent-modal"),
    (existing) => existing ?? defaultTab,
  );

  const handleTabChange = (nextTab: ConnectionTab) => {
    if (nextTab !== activeTab) {
      track("connections_dialog_tab_changed", { to_tab: nextTab });
    }
    setActiveTab(nextTab);
  };

  // Connections - server-side search with infinite scroll
  const PAGE_SIZE = 100;
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  // Split on whitespace into keywords, each OR'd across title/description — so
  // "vtex shopify" matches connections for either provider (union).
  const searchTokens =
    deferredSearch?.trim().split(/\s+/).filter(Boolean) ?? [];
  const where =
    searchTokens.length > 0
      ? {
          operator: "or" as const,
          conditions: searchTokens.flatMap((token) => [
            { field: ["title"], operator: "contains" as const, value: token },
            {
              field: ["description"],
              operator: "contains" as const,
              value: token,
            },
          ]),
        }
      : undefined;

  const toolArguments = {
    ...(where && { where }),
    orderBy: [{ field: ["updated_at"], direction: "asc" as const }],
    limit: PAGE_SIZE,
    offset: 0,
  };
  const argsKey = JSON.stringify(toolArguments);

  const {
    data: connectionsData,
    fetchNextPage: fetchNextConnectionsPage,
    hasNextPage: hasNextConnectionsPage,
    isFetchingNextPage: isFetchingNextConnectionsPage,
  } = useSuspenseInfiniteQuery({
    queryKey: KEYS.collectionListInfinite(
      client,
      org.id,
      "",
      "CONNECTIONS",
      argsKey,
    ),
    queryFn: async ({ pageParam = 0 }) => {
      const result = await client.callTool({
        name: "COLLECTION_CONNECTIONS_LIST",
        arguments: {
          ...(where && { where }),
          orderBy: [{ field: ["updated_at"], direction: "asc" }],
          limit: PAGE_SIZE,
          offset: pageParam,
        },
      });
      return result.structuredContent as CollectionListOutput<ConnectionEntity>;
    },
    initialPageParam: 0,
    getNextPageParam: (
      lastPage: CollectionListOutput<ConnectionEntity>,
      allPages: CollectionListOutput<ConnectionEntity>[],
    ) => {
      if (!lastPage?.hasMore) return undefined;
      return allPages.reduce(
        (sum: number, page: CollectionListOutput<ConnectionEntity>) =>
          sum + (page?.items?.length ?? 0),
        0,
      );
    },
    staleTime: 30_000,
  });

  const allConnections =
    connectionsData?.pages.flatMap(
      (p: CollectionListOutput<ConnectionEntity>) => p?.items ?? [],
    ) ?? [];
  const grouped = groupConnections(allConnections);

  // Build set of connected app names to deduplicate catalog items
  const connectedAppNames = new Set(
    allConnections.filter((c) => c.app_name).map((c) => c.app_name as string),
  );

  // Registry / catalog
  const enabledRegistries = useEnabledRegistries();
  const mergedDiscovery = useMergedStoreDiscovery(
    enabledRegistries,
    deferredSearch,
  );

  const catalogSentinelRef = useInfiniteScroll(
    mergedDiscovery.loadMore,
    mergedDiscovery.hasMore,
    mergedDiscovery.isLoadingMore,
  );

  const connectedSentinelRef = useInfiniteScroll(
    fetchNextConnectionsPage,
    hasNextConnectionsPage ?? false,
    isFetchingNextConnectionsPage,
  );

  const showCatalog = activeTab === "all" || !!searchLower;

  // Catalog items, excluding apps already shown as connected cards.
  // The client-side search filter is a safety net: `useMergedStoreDiscovery`
  // uses `keepPreviousData`, so the previous query's results (sorted with
  // verified items first) stay visible while a new search request is in
  // flight. Without this filter, the user sees unrelated items that happened
  // to be in the previous page.
  const catalogItems = showCatalog
    ? mergedDiscovery.items.filter((item: RegistryItem) => {
        const appName = getRegistryItemAppName(item);
        if (appName && connectedAppNames.has(appName)) return false;
        if (!searchLower) return true;
        const studioMeta = item._meta?.["mcp.mesh"];
        const haystack = [
          item.title,
          item.description,
          item.name,
          item.server?.title,
          item.server?.description,
          item.server?.name,
          studioMeta?.friendly_name,
          studioMeta?.friendlyName,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        // Match any keyword (union), mirroring the server-side where clause.
        return searchTokens.some((token) =>
          haystack.includes(token.toLowerCase()),
        );
      })
    : [];

  const verifiedCatalogItems = catalogItems.filter(
    (item: RegistryItem) =>
      item.verified ||
      item._meta?.["mcp.mesh"]?.verified ||
      item.meta?.verified,
  );
  const otherCatalogItems = catalogItems.filter(
    (item: RegistryItem) =>
      !item.verified &&
      !item._meta?.["mcp.mesh"]?.verified &&
      !item.meta?.verified,
  );

  // For connected apps: check if any instance is added to the agent
  const hasAddedInstance = (connections: ConnectionEntity[]) =>
    connections.some((c) => addedConnectionIds.has(c.id));

  // Render a connected app card
  const renderConnectedApp = (
    key: string,
    title: string,
    icon: string | null,
    description: string | null,
    connections: ConnectionEntity[],
  ) => {
    const added = hasAddedInstance(connections);
    const availableInstance = connections.find(
      (c) => !addedConnectionIds.has(c.id),
    );
    const firstInstance = connections[0]!;

    if (mode === "browse") {
      const slug = getConnectionSlug(firstInstance);
      return (
        <ConnectionCard
          key={key}
          connection={{
            title,
            icon,
            description:
              connections.length > 1
                ? `${connections.length} instances`
                : (description ?? undefined),
          }}
          fallbackIcon={<Container />}
          headerActionsAlwaysVisible
          headerActions={
            <Badge variant="secondary" className="text-xs gap-1 font-normal">
              <Check size={11} />{" "}
              {t("virtualMcp.connectionDialogContent.connected")}
            </Badge>
          }
          onClick={() => {
            track("connection_browse_clicked", {
              app_name: firstInstance.app_name ?? null,
              connection_id: firstInstance.id,
              instances_count: connections.length,
            });
            onBrowseNavigate?.(slug);
          }}
        />
      );
    }

    return (
      <ConnectionCard
        key={key}
        connection={{ title, icon, description }}
        fallbackIcon={<Container />}
        headerActionsAlwaysVisible
        headerActions={
          <div className="flex items-center gap-1.5">
            {added && (
              <Badge variant="secondary" className="text-xs gap-1 font-normal">
                <Check size={11} />{" "}
                {t("virtualMcp.connectionDialogContent.added")}
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs font-medium"
              disabled={connectingItemId !== null}
              onClick={(e) => {
                e.stopPropagation();
                if (availableInstance) {
                  track("connection_add_clicked", {
                    action: "use_existing",
                    app_name: firstInstance.app_name ?? null,
                    connection_id: availableInstance.id,
                  });
                  if (agentId) {
                    track("agent_connection_attached", {
                      agent_id: agentId,
                      connection_id: availableInstance.id,
                      app_name: firstInstance.app_name ?? null,
                      mode: "existing",
                    });
                  }
                  onAdd(availableInstance.id);
                } else {
                  track("connection_add_clicked", {
                    action: "clone",
                    app_name: firstInstance.app_name ?? null,
                    base_connection_id: firstInstance.id,
                  });
                  onCloneAndAdd(firstInstance);
                }
              }}
            >
              {t("virtualMcp.connectionDialogContent.add")}
            </Button>
          </div>
        }
      />
    );
  };

  // Render a catalog item card — no instances yet
  const renderCatalogItem = (item: RegistryItem) => {
    const studioMeta = item._meta?.["mcp.mesh"];
    const title =
      studioMeta?.friendlyName ||
      studioMeta?.friendly_name ||
      item.server?.title ||
      item.title ||
      item.server?.name ||
      item.name ||
      item.id ||
      "";
    const description = item.server?.description || item.description || null;
    const icon =
      item.server?.icons?.[0]?.src ||
      getGitHubAvatarUrl(item.server?.repository) ||
      null;
    const isOfficial = studioMeta?.official === true;
    const isVerified = studioMeta?.verified === true;
    const isMadeByDeco = studioMeta?.owner === "deco";

    return (
      <ConnectionCard
        key={`catalog-${item.id}`}
        connection={{ title, description, icon }}
        fallbackIcon={<Container />}
        headerActionsAlwaysVisible
        headerActions={
          <div className="flex items-center gap-1.5">
            {isMadeByDeco && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center justify-center size-5 rounded-md bg-muted shrink-0">
                    <img
                      src="/logos/deco logo.svg"
                      alt={t("virtualMcp.connectionDialogContent.madeByDeco")}
                      className="size-3"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {t("virtualMcp.connectionDialogContent.builtByDeco")}
                </TooltipContent>
              </Tooltip>
            )}
            {!isMadeByDeco && isOfficial && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" size="icon">
                    <CheckVerified02 />
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  {t("virtualMcp.connectionDialogContent.builtByOfficial")}
                </TooltipContent>
              </Tooltip>
            )}
            {!isMadeByDeco && !isOfficial && isVerified && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" size="icon">
                    <CheckVerified02 />
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  {t("virtualMcp.connectionDialogContent.verifiedByDeco")}
                </TooltipContent>
              </Tooltip>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs font-medium"
              disabled={connectingItemId !== null}
              onClick={(e) => {
                e.stopPropagation();
                track("connection_add_clicked", {
                  action: "connect_new",
                  registry_item_id: item.id,
                  app_name:
                    studioMeta?.friendlyName ||
                    item.server?.name ||
                    item.name ||
                    null,
                });
                onConnectAndAdd(item);
              }}
            >
              {connectingItemId === item.id ? (
                <Loading01 size={14} className="animate-spin" />
              ) : mode === "browse" ? (
                t("virtualMcp.connectionDialogContent.connect")
              ) : (
                t("virtualMcp.connectionDialogContent.add")
              )}
            </Button>
          </div>
        }
      />
    );
  };

  return (
    <>
      {/* Tabs — hidden when searching */}
      {!searchLower && (
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <CollectionTabs
            tabs={[
              {
                id: "all",
                label: t("virtualMcp.connectionDialogContent.tabAll"),
              },
              {
                id: "connected",
                label: t("virtualMcp.connectionDialogContent.tabConnected"),
              },
            ]}
            activeTab={activeTab}
            onTabChange={(id) => handleTabChange(id as ConnectionTab)}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-sm"
            onClick={() => {
              track("connections_dialog_custom_clicked");
              onCreateConnection();
            }}
          >
            <Plus size={12} />
            {t("virtualMcp.connectionDialogContent.customConnection")}
          </Button>
        </div>
      )}

      {/* Content grid */}
      <div
        className={cn(
          "flex-1 overflow-auto p-5 transition-opacity duration-150",
          isSearchStale && "opacity-50 pointer-events-none",
        )}
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {/* Connected apps — one card per app */}
          {grouped.map((item) => {
            if (item.type === "group") {
              return renderConnectedApp(
                item.key,
                item.title,
                item.icon,
                null,
                item.connections,
              );
            }
            const c = item.connection;
            return renderConnectedApp(
              c.id,
              c.title,
              c.icon,
              c.description ?? null,
              [c],
            );
          })}

          {/* Infinite scroll sentinel for connected results */}
          <div ref={connectedSentinelRef} className="col-span-full h-1" />
          {isFetchingNextConnectionsPage && (
            <div className="col-span-full flex justify-center py-6">
              <Loading01
                size={24}
                className="animate-spin text-muted-foreground"
              />
            </div>
          )}

          {/* Verified catalog items */}
          {showCatalog && verifiedCatalogItems.length > 0 && (
            <div className="col-span-full flex items-center gap-2 mt-2">
              <CheckVerified02
                size={13}
                className="text-muted-foreground shrink-0"
              />
              <span className="text-sm font-medium text-muted-foreground whitespace-nowrap">
                {t("virtualMcp.connectionDialogContent.sectionVerified")}
              </span>
              <div className="flex-1 h-px bg-border" />
            </div>
          )}
          {showCatalog && verifiedCatalogItems.map(renderCatalogItem)}

          {/* Other catalog items */}
          {showCatalog && otherCatalogItems.length > 0 && (
            <div className="col-span-full flex items-center gap-2 mt-2">
              <span className="text-sm font-medium text-muted-foreground whitespace-nowrap">
                {t("virtualMcp.connectionDialogContent.sectionAllConnections")}
              </span>
              <div className="flex-1 h-px bg-border" />
            </div>
          )}
          {showCatalog && otherCatalogItems.map(renderCatalogItem)}

          {/* Catalog infinite scroll sentinel */}
          {showCatalog && enabledRegistries.length > 0 && (
            <div ref={catalogSentinelRef} className="col-span-full h-1" />
          )}
          {showCatalog && mergedDiscovery.isLoadingMore && (
            <div className="col-span-full flex justify-center py-6">
              <Loading01
                size={24}
                className="animate-spin text-muted-foreground"
              />
            </div>
          )}
        </div>

        {/* Empty states */}
        {grouped.length === 0 &&
          verifiedCatalogItems.length === 0 &&
          otherCatalogItems.length === 0 && (
            <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
              {search
                ? t(
                    "virtualMcp.connectionDialogContent.emptyStateSearchNoMatch",
                    { search },
                  )
                : activeTab === "connected"
                  ? t(
                      "virtualMcp.connectionDialogContent.emptyStateNoConnectionsYet",
                    )
                  : t(
                      "virtualMcp.connectionDialogContent.emptyStateNoConnectionsAvailable",
                    )}
            </div>
          )}
      </div>
    </>
  );
}

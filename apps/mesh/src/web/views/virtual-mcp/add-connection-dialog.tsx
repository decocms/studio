import { groupConnections } from "@/shared/utils/group-connections";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { CollectionTabs } from "@/web/components/collections/collection-tabs.tsx";
import { CreateConnectionDialog } from "@/web/components/connections/create-connection-dialog.tsx";
import { ConnectionCard } from "@/web/components/connections/connection-card.tsx";
import type { RegistryItem } from "@/web/components/store/types";
import { useInfiniteScroll } from "@/web/hooks/use-infinite-scroll";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import {
  authenticateMcp,
  isConnectionAuthenticated,
} from "@/web/lib/mcp-oauth";
import { KEYS } from "@/web/lib/query-keys";
import { authClient } from "@/web/lib/auth-client";
import {
  extractConnectionData,
  getRegistryItemAppName,
} from "@/web/utils/extract-connection-data";
import { getGitHubAvatarUrl } from "@/web/utils/github";
import { useEnabledRegistries } from "@/web/hooks/use-enabled-registries";
import { useMergedStoreDiscovery } from "@/web/hooks/use-merged-store-discovery";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  type ConnectionEntity,
  SELF_MCP_ALIAS_ID,
  useConnectionActions,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { CollectionListOutput } from "@decocms/bindings/collections";
import {
  useQueryClient,
  useSuspenseInfiniteQuery,
} from "@tanstack/react-query";
import {
  Check,
  CheckVerified02,
  Container,
  Loading01,
  Plus,
} from "@untitledui/icons";
import { Suspense, useDeferredValue, useState } from "react";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AddConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  addedConnectionIds: Set<string>;
  onAdd: (connectionId: string) => void;
  defaultTab?: "all" | "connected";
}

// ---------------------------------------------------------------------------
// Dialog content (needs Suspense boundary above it)
// ---------------------------------------------------------------------------

type ConnectionTab = "all" | "connected";

function AddConnectionDialogContent({
  addedConnectionIds,
  onAdd,
  onCloneAndAdd,
  onConnectAndAdd,
  connectingItemId,
  search,
  onCreateConnection,
  defaultTab = "connected",
}: {
  addedConnectionIds: Set<string>;
  onAdd: (connectionId: string) => void;
  onCloneAndAdd: (base: ConnectionEntity) => void;
  onConnectAndAdd: (item: RegistryItem) => void;
  connectingItemId: string | null;
  search: string;
  onCreateConnection: () => void;
  defaultTab?: "all" | "connected";
}) {
  const { org } = useProjectContext();
  const deferredSearch = useDeferredValue(search);
  const isSearchStale = search !== deferredSearch;
  const searchLower = deferredSearch.toLowerCase();

  const [activeTab, setActiveTab] = useLocalStorage<ConnectionTab>(
    LOCALSTORAGE_KEYS.connectionsTab(org.slug) +
      (defaultTab === "all" ? ":home-modal" : ":agent-modal"),
    (existing) => existing ?? defaultTab,
  );

  // Connections - server-side search with infinite scroll
  const PAGE_SIZE = 100;
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const where = deferredSearch?.trim()
    ? {
        operator: "or" as const,
        conditions: [
          {
            field: ["title"],
            operator: "contains" as const,
            value: deferredSearch.trim(),
          },
          {
            field: ["description"],
            operator: "contains" as const,
            value: deferredSearch.trim(),
          },
        ],
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

  // Catalog items, excluding apps already shown as connected cards
  const catalogItems = showCatalog
    ? mergedDiscovery.items.filter((item: RegistryItem) => {
        const appName = getRegistryItemAppName(item);
        return !(appName && connectedAppNames.has(appName));
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

  // Render a connected app card — has instances, "Add" adds first instance
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
                <Check size={11} /> Added
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
                  onAdd(availableInstance.id);
                } else {
                  onCloneAndAdd(firstInstance);
                }
              }}
            >
              Add
            </Button>
          </div>
        }
      />
    );
  };

  // Render a catalog item card — no instances yet, "Add" creates + adds
  const renderCatalogItem = (item: RegistryItem) => {
    const meshMeta = item._meta?.["mcp.mesh"] as
      | Record<string, string>
      | undefined;
    const title =
      meshMeta?.friendlyName ||
      meshMeta?.friendly_name ||
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

    return (
      <ConnectionCard
        key={`catalog-${item.id}`}
        connection={{ title, description, icon }}
        fallbackIcon={<Container />}
        headerActionsAlwaysVisible
        headerActions={
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs font-medium"
            disabled={connectingItemId !== null}
            onClick={(e) => {
              e.stopPropagation();
              onConnectAndAdd(item);
            }}
          >
            {connectingItemId === item.id ? (
              <Loading01 size={14} className="animate-spin" />
            ) : (
              "Add"
            )}
          </Button>
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
              { id: "all", label: "All" },
              { id: "connected", label: "Connected" },
            ]}
            activeTab={activeTab}
            onTabChange={(id) => setActiveTab(id as ConnectionTab)}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-sm"
            onClick={onCreateConnection}
          >
            <Plus size={12} />
            Custom Connection
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
                Verified
              </span>
              <div className="flex-1 h-px bg-border" />
            </div>
          )}
          {showCatalog && verifiedCatalogItems.map(renderCatalogItem)}

          {/* Other catalog items */}
          {showCatalog && otherCatalogItems.length > 0 && (
            <div className="col-span-full flex items-center gap-2 mt-2">
              <span className="text-sm font-medium text-muted-foreground whitespace-nowrap">
                All connections
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
                ? `No connections match "${search}"`
                : activeTab === "connected"
                  ? "No connections yet"
                  : "No connections available"}
            </div>
          )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Dialog
// ---------------------------------------------------------------------------

export function AddConnectionDialog({
  open,
  onOpenChange,
  addedConnectionIds,
  onAdd,
  defaultTab,
}: AddConnectionDialogProps) {
  const [connectingItemId, setConnectingItemId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const connectionActions = useConnectionActions();
  const queryClient = useQueryClient();

  // For connected apps: clone existing connection + add to agent
  const handleCloneAndAdd = async (base: ConnectionEntity) => {
    setConnectingItemId(base.app_name ?? base.id);
    try {
      const baseName = base.title.replace(/\s*\(\d+\)\s*$/, "");
      const newTitle = `${baseName} (${Date.now().toString(36).slice(-4)})`;

      const created = await connectionActions.create.mutateAsync({
        title: newTitle,
        description: base.description ?? null,
        connection_type: base.connection_type,
        connection_url: base.connection_url ?? null,
        connection_token: null,
        icon: base.icon ?? null,
        app_name: base.app_name ?? null,
        app_id: base.app_id ?? null,
        connection_headers: base.connection_headers ?? null,
      });
      const id = created.id;

      // Handle OAuth if needed
      const mcpProxyUrl = new URL(`/mcp/${id}`, window.location.origin);
      const authStatus = await isConnectionAuthenticated({
        url: mcpProxyUrl.href,
        token: null,
      });

      if (authStatus.supportsOAuth && !authStatus.isAuthenticated) {
        const { token, tokenInfo, error } = await authenticateMcp({
          connectionId: id,
        });
        if (error || !token) {
          toast.error(`Authentication failed: ${error ?? "no token received"}`);
          // Clean up the orphaned connection
          await connectionActions.delete.mutateAsync(id);
          return;
        }
        if (tokenInfo) {
          try {
            const response = await fetch(`/api/connections/${id}/oauth-token`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                accessToken: tokenInfo.accessToken,
                refreshToken: tokenInfo.refreshToken,
                expiresIn: tokenInfo.expiresIn,
                scope: tokenInfo.scope,
                clientId: tokenInfo.clientId,
                clientSecret: tokenInfo.clientSecret,
                tokenEndpoint: tokenInfo.tokenEndpoint,
              }),
            });
            if (!response.ok) {
              await connectionActions.update.mutateAsync({
                id,
                data: { connection_token: token },
              });
            } else {
              await connectionActions.update.mutateAsync({ id, data: {} });
            }
          } catch {
            await connectionActions.update.mutateAsync({
              id,
              data: { connection_token: token },
            });
          }
        } else {
          await connectionActions.update.mutateAsync({
            id,
            data: { connection_token: token },
          });
        }
        await queryClient.invalidateQueries({
          queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
        });
      }

      onAdd(id);
    } catch (err) {
      console.error("Failed to add connection:", err);
      toast.error("Failed to add connection");
    } finally {
      setConnectingItemId(null);
    }
  };

  // For catalog items with no instances: create connection + add to agent
  const handleConnectAndAdd = async (item: RegistryItem) => {
    if (!org || !session?.user?.id) return;
    setConnectingItemId(item.id);

    try {
      const connectionData = extractConnectionData(
        item,
        org.id,
        session.user.id,
        { remoteIndex: 0 },
      );

      const isStdioConnection = connectionData.connection_type === "STDIO";
      const hasUrl = Boolean(connectionData.connection_url);
      const hasStdioConfig =
        isStdioConnection &&
        connectionData.connection_headers &&
        typeof connectionData.connection_headers === "object" &&
        "command" in connectionData.connection_headers;

      if (!hasUrl && !hasStdioConfig) {
        toast.error(
          "This MCP Server cannot be connected: no connection method available",
        );
        setConnectingItemId(null);
        return;
      }

      const { id } = await connectionActions.create.mutateAsync(connectionData);

      // Handle OAuth flow
      const mcpProxyUrl = new URL(`/mcp/${id}`, window.location.origin);
      const authStatus = await isConnectionAuthenticated({
        url: mcpProxyUrl.href,
        token: null,
      });

      if (authStatus.supportsOAuth && !authStatus.isAuthenticated) {
        const { token, tokenInfo, error } = await authenticateMcp({
          connectionId: id,
        });
        if (error || !token) {
          toast.error(`Authentication failed: ${error ?? "no token received"}`);
          onAdd(id);
          return;
        }

        if (tokenInfo) {
          try {
            const response = await fetch(`/api/connections/${id}/oauth-token`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                accessToken: tokenInfo.accessToken,
                refreshToken: tokenInfo.refreshToken,
                expiresIn: tokenInfo.expiresIn,
                scope: tokenInfo.scope,
                clientId: tokenInfo.clientId,
                clientSecret: tokenInfo.clientSecret,
                tokenEndpoint: tokenInfo.tokenEndpoint,
              }),
            });
            if (!response.ok) {
              await connectionActions.update.mutateAsync({
                id,
                data: { connection_token: token },
              });
            } else {
              await connectionActions.update.mutateAsync({ id, data: {} });
            }
          } catch {
            await connectionActions.update.mutateAsync({
              id,
              data: { connection_token: token },
            });
          }
        } else {
          await connectionActions.update.mutateAsync({
            id,
            data: { connection_token: token },
          });
        }

        await queryClient.invalidateQueries({
          queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
        });
        toast.success("Connected and authenticated");
      } else {
        toast.success("Connected");
      }

      onAdd(id);
    } catch (err) {
      console.error("Failed to connect:", err);
      toast.error("Failed to connect");
    } finally {
      setConnectingItemId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl h-[85vh] max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden w-[95vw]">
        <DialogHeader className="px-6 pt-5 pb-0 shrink-0">
          <DialogTitle className="text-base font-semibold">
            Add Connection
          </DialogTitle>
        </DialogHeader>

        <div className="pt-3 shrink-0">
          <CollectionSearch
            value={search}
            onChange={setSearch}
            placeholder="Search connections..."
          />
        </div>

        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center">
              <Loading01
                size={24}
                className="animate-spin text-muted-foreground"
              />
            </div>
          }
        >
          <AddConnectionDialogContent
            addedConnectionIds={addedConnectionIds}
            onAdd={onAdd}
            onCloneAndAdd={handleCloneAndAdd}
            onConnectAndAdd={handleConnectAndAdd}
            connectingItemId={connectingItemId}
            search={search}
            onCreateConnection={() => setCreateOpen(true)}
            defaultTab={defaultTab}
          />
        </Suspense>
      </DialogContent>

      <CreateConnectionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={async (id) => {
          setCreateOpen(false);

          // Handle OAuth if needed (same flow as handleConnectAndAdd)
          const mcpProxyUrl = new URL(`/mcp/${id}`, window.location.origin);
          const authStatus = await isConnectionAuthenticated({
            url: mcpProxyUrl.href,
            token: null,
          });

          if (authStatus.supportsOAuth && !authStatus.isAuthenticated) {
            const { token, tokenInfo, error } = await authenticateMcp({
              connectionId: id,
            });
            if (error || !token) {
              toast.error(
                `Authentication failed: ${error ?? "no token received"}`,
              );
              await connectionActions.delete.mutateAsync(id);
              return;
            }
            if (tokenInfo) {
              try {
                const response = await fetch(
                  `/api/connections/${id}/oauth-token`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({
                      accessToken: tokenInfo.accessToken,
                      refreshToken: tokenInfo.refreshToken,
                      expiresIn: tokenInfo.expiresIn,
                      scope: tokenInfo.scope,
                      clientId: tokenInfo.clientId,
                      clientSecret: tokenInfo.clientSecret,
                      tokenEndpoint: tokenInfo.tokenEndpoint,
                    }),
                  },
                );
                if (!response.ok) {
                  await connectionActions.update.mutateAsync({
                    id,
                    data: { connection_token: token },
                  });
                } else {
                  await connectionActions.update.mutateAsync({
                    id,
                    data: {},
                  });
                }
              } catch {
                await connectionActions.update.mutateAsync({
                  id,
                  data: { connection_token: token },
                });
              }
            } else {
              await connectionActions.update.mutateAsync({
                id,
                data: { connection_token: token },
              });
            }
            await queryClient.invalidateQueries({
              queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
            });
          }

          onAdd(id);
          onOpenChange(false);
        }}
      />
    </Dialog>
  );
}

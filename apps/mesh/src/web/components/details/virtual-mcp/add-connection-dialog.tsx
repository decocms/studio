import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { CollectionTabs } from "@/web/components/collections/collection-tabs.tsx";
import { ConnectionCard } from "@/web/components/connections/connection-card.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import type { RegistryItem } from "@/web/components/store/types";
import { useRegistryConnections } from "@/web/hooks/use-binding";
import { useInfiniteScroll } from "@/web/hooks/use-infinite-scroll";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { useStoreDiscovery } from "@/web/hooks/use-store-discovery";
import {
  authenticateMcp,
  isConnectionAuthenticated,
} from "@/web/lib/mcp-oauth";
import { KEYS } from "@/web/lib/query-keys";
import { authClient } from "@/web/lib/auth-client";
import { extractConnectionData } from "@/web/utils/extract-connection-data";
import { getConnectionSlug } from "@/web/utils/connection-slug";
import { getGitHubAvatarUrl } from "@/web/utils/github";
import { findListToolName } from "@/web/utils/registry-utils";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  type ConnectionEntity,
  useConnectionActions,
  useConnections,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CheckVerified02,
  ChevronDown,
  Container,
  Loading01,
  Plus,
} from "@untitledui/icons";
import { Suspense, useState } from "react";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AddConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  addedConnectionIds: Set<string>;
  onAdd: (connectionId: string) => void;
}

// ---------------------------------------------------------------------------
// Grouping (same pattern as connections page)
// ---------------------------------------------------------------------------

interface ConnectionGroup {
  type: "group";
  key: string;
  icon: string | null;
  title: string;
  connections: ConnectionEntity[];
}

interface SingleConnection {
  type: "single";
  connection: ConnectionEntity;
}

type GroupedItem = SingleConnection | ConnectionGroup;

function groupConnections(connections: ConnectionEntity[]): GroupedItem[] {
  const buckets = new Map<string, ConnectionEntity[]>();
  for (const c of connections) {
    if (c.connection_type === "VIRTUAL") continue;
    const key = getConnectionSlug(c);
    const list = buckets.get(key);
    if (list) {
      list.push(c);
    } else {
      buckets.set(key, [c]);
    }
  }

  const items: GroupedItem[] = [];
  const seen = new Set<string>();

  for (const c of connections) {
    if (c.connection_type === "VIRTUAL") continue;
    const key = getConnectionSlug(c);
    if (seen.has(key)) continue;
    seen.add(key);

    const bucket = buckets.get(key)!;
    const first = bucket[0]!;
    if (bucket.length === 1) {
      items.push({ type: "single", connection: first });
    } else {
      items.push({
        type: "group",
        key,
        icon: first.icon,
        title: first.app_name
          ? first.title.replace(/\s*\(\d+\)\s*$/, "")
          : first.title,
        connections: bucket,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Add button for connection cards
// ---------------------------------------------------------------------------

function AddButton({
  added,
  onClick,
}: {
  added: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant={added ? "ghost" : "outline"}
      size="sm"
      className="h-7 px-2 text-xs font-medium"
      disabled={added}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {added ? <Check size={13} /> : <Plus size={13} />}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Dialog content (needs Suspense boundary above it)
// ---------------------------------------------------------------------------

type ConnectionTab = "all" | "connected";

function AddConnectionDialogContent({
  addedConnectionIds,
  onAdd,
  onInlineConnect,
  connectingItemId,
}: {
  addedConnectionIds: Set<string>;
  onAdd: (connectionId: string) => void;
  onInlineConnect: (item: RegistryItem) => void;
  connectingItemId: string | null;
}) {
  const { org } = useProjectContext();
  const [search, setSearch] = useState("");
  const searchLower = search.toLowerCase();

  const [activeTab, setActiveTab] = useLocalStorage<ConnectionTab>(
    LOCALSTORAGE_KEYS.connectionsTab(org.slug) + ":agent-modal",
    () => "all",
  );

  // Connections
  const allConnections = useConnections();
  const nonVirtual = allConnections.filter(
    (c) => c.connection_type !== "VIRTUAL",
  );
  const filteredConnections = search
    ? nonVirtual.filter(
        (c) =>
          c.title.toLowerCase().includes(searchLower) ||
          c.description?.toLowerCase().includes(searchLower),
      )
    : nonVirtual;
  const grouped = groupConnections(filteredConnections);

  // Registry / catalog
  const registryConnections = useRegistryConnections(allConnections).sort(
    (a, b) => {
      const isSelfA = a.app_name === "@deco/management-mcp";
      const isSelfB = b.app_name === "@deco/management-mcp";
      if (isSelfA && !isSelfB) return 1;
      if (!isSelfA && isSelfB) return -1;
      return 0;
    },
  );
  const [selectedRegistryId, setSelectedRegistryId] = useLocalStorage<string>(
    LOCALSTORAGE_KEYS.selectedRegistry(org.slug),
    (existing) => existing ?? "",
  );
  const registryConnection =
    (selectedRegistryId
      ? registryConnections.find((r) => r.id === selectedRegistryId)
      : undefined) ?? registryConnections[0];
  const registryId = registryConnection?.id ?? "";
  const registryListToolName = findListToolName(registryConnection?.tools);
  const registryDiscovery = useStoreDiscovery({
    registryId,
    listToolName: registryListToolName,
    search: searchLower,
  });

  const catalogSentinelRef = useInfiniteScroll(
    registryDiscovery.loadMore,
    registryDiscovery.hasMore,
    registryDiscovery.isLoadingMore,
  );

  const connectedAppNames = new Set(
    allConnections
      .filter((c) => c.connection_type !== "VIRTUAL" && c.app_name)
      .map((c) => c.app_name as string),
  );

  const catalogItems =
    activeTab === "all" || searchLower
      ? registryDiscovery.items.filter((item) => {
          if (!searchLower) return true;
          const meshMeta = item._meta?.["mcp.mesh"] as
            | Record<string, string>
            | undefined;
          const title = [
            meshMeta?.friendly_name,
            item.server?.name,
            item.server?.title,
            item.name,
            item.title,
            item.id,
          ]
            .filter(Boolean)
            .join(" ");
          const desc = [
            meshMeta?.short_description,
            meshMeta?.mesh_description,
            item.server?.description,
            item.description,
          ]
            .filter(Boolean)
            .join(" ");
          return (
            title.toLowerCase().includes(searchLower) ||
            desc.toLowerCase().includes(searchLower)
          );
        })
      : [];

  const verifiedCatalogItems = catalogItems.filter(
    (item) =>
      item.verified ||
      item._meta?.["mcp.mesh"]?.verified ||
      item.meta?.verified,
  );
  const otherCatalogItems = catalogItems.filter(
    (item) =>
      !item.verified &&
      !item._meta?.["mcp.mesh"]?.verified &&
      !item.meta?.verified,
  );

  // In "All" tab, don't show connected at top — they belong in "Connected" tab
  // But when searching, show connected results across both
  const groupedForDisplay = activeTab === "all" && !searchLower ? [] : grouped;

  const isGroupAdded = (connections: ConnectionEntity[]) =>
    connections.some((c) => addedConnectionIds.has(c.id));

  // Render a catalog item card
  const renderCatalogItem = (item: RegistryItem) => {
    const appName = item.server?.name || item.name || item.id || "";
    const isConnected = connectedAppNames.has(appName);
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

    // If already connected, find instances to let user add them directly
    const appInstances = isConnected
      ? allConnections.filter(
          (c) => c.connection_type !== "VIRTUAL" && c.app_name === appName,
        )
      : [];
    const firstInstance = appInstances[0];
    const firstAdded = firstInstance
      ? addedConnectionIds.has(firstInstance.id)
      : false;

    return (
      <ConnectionCard
        key={`catalog-${item.id}`}
        connection={{ title, description, icon }}
        fallbackIcon={<Container />}
        headerActionsAlwaysVisible
        headerActions={
          isConnected ? (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Connected</span>
              {firstInstance && (
                <AddButton
                  added={firstAdded}
                  onClick={() => onAdd(firstInstance.id)}
                />
              )}
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs font-medium"
              disabled={connectingItemId !== null}
              onClick={(e) => {
                e.stopPropagation();
                onInlineConnect(item);
              }}
            >
              {connectingItemId === item.id ? (
                <Loading01 size={14} className="animate-spin" />
              ) : (
                "Connect"
              )}
            </Button>
          )
        }
      />
    );
  };

  return (
    <>
      {/* Search */}
      <div className="pt-3 shrink-0">
        <CollectionSearch
          value={search}
          onChange={setSearch}
          placeholder="Search connections..."
        />
      </div>

      {/* Tabs + Registry selector */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
        <CollectionTabs
          tabs={[
            { id: "all", label: "All" },
            { id: "connected", label: "Connected" },
          ]}
          activeTab={activeTab}
          onTabChange={(id) => setActiveTab(id as ConnectionTab)}
        />
        {registryConnections.length > 0 && (
          <div
            className={cn(
              activeTab !== "all" && "invisible pointer-events-none",
            )}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 gap-1.5 text-sm font-normal"
                >
                  {(() => {
                    const active =
                      registryConnections.find(
                        (rc) =>
                          rc.id ===
                          (selectedRegistryId || registryConnections[0]?.id),
                      ) ?? registryConnections[0];
                    return (
                      <>
                        <IntegrationIcon
                          icon={active?.icon}
                          name={active?.title ?? ""}
                          size="2xs"
                          className="shrink-0 rounded-sm"
                        />
                        <span>{active?.title}</span>
                      </>
                    );
                  })()}
                  <ChevronDown size={14} className="text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {registryConnections.map((rc) => (
                  <DropdownMenuItem
                    key={rc.id}
                    onClick={() => setSelectedRegistryId(rc.id)}
                    className={cn(
                      selectedRegistryId === rc.id ||
                        (!selectedRegistryId &&
                          rc.id === registryConnections[0]?.id)
                        ? "bg-accent"
                        : "",
                    )}
                  >
                    <IntegrationIcon
                      icon={rc.icon}
                      name={rc.title}
                      size="2xs"
                      className="shrink-0 rounded-sm"
                    />
                    {rc.title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {/* Content grid */}
      <div className="flex-1 overflow-auto p-5">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {/* Connected connections (shown in Connected tab, or in All when searching) */}
          {groupedForDisplay.map((item) => {
            if (item.type === "group") {
              const added = isGroupAdded(item.connections);
              const firstInstance = item.connections[0]!;
              return (
                <ConnectionCard
                  key={item.key}
                  connection={{
                    title: item.title,
                    icon: item.icon,
                    description: `${item.connections.length} instances`,
                  }}
                  fallbackIcon={<Container />}
                  headerActionsAlwaysVisible
                  headerActions={
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-muted-foreground">
                        Connected
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        x{item.connections.length}
                      </span>
                      <AddButton
                        added={added}
                        onClick={() => onAdd(firstInstance.id)}
                      />
                    </div>
                  }
                />
              );
            }

            const connection = item.connection;
            const added = addedConnectionIds.has(connection.id);
            return (
              <ConnectionCard
                key={connection.id}
                connection={connection}
                fallbackIcon={<Container />}
                headerActionsAlwaysVisible
                headerActions={
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      Connected
                    </span>
                    <AddButton
                      added={added}
                      onClick={() => onAdd(connection.id)}
                    />
                  </div>
                }
              />
            );
          })}

          {/* Verified catalog items */}
          {(activeTab === "all" || searchLower) &&
            verifiedCatalogItems.length > 0 && (
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
          {verifiedCatalogItems.map(renderCatalogItem)}

          {/* Other catalog items */}
          {(activeTab === "all" || searchLower) &&
            otherCatalogItems.length > 0 && (
              <div className="col-span-full flex items-center gap-2 mt-2">
                <span className="text-sm font-medium text-muted-foreground whitespace-nowrap">
                  All connections
                </span>
                <div className="flex-1 h-px bg-border" />
              </div>
            )}
          {otherCatalogItems.map(renderCatalogItem)}

          {/* Infinite scroll sentinel */}
          {(activeTab === "all" || searchLower) && registryId && (
            <div ref={catalogSentinelRef} className="col-span-full h-4" />
          )}
          {(activeTab === "all" || searchLower) &&
            registryDiscovery.isLoadingMore && (
              <div className="col-span-full flex justify-center py-6">
                <Loading01
                  size={24}
                  className="animate-spin text-muted-foreground"
                />
              </div>
            )}
        </div>

        {/* Empty states */}
        {groupedForDisplay.length === 0 &&
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
}: AddConnectionDialogProps) {
  const [connectingItemId, setConnectingItemId] = useState<string | null>(null);
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const connectionActions = useConnectionActions();
  const queryClient = useQueryClient();
  const allConnections = useConnections();

  const handleInlineConnect = async (item: RegistryItem) => {
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

      // Check for duplicates
      const appName = item.id ?? item.title;
      const existing = allConnections.filter(
        (c) => c.app_name === appName || c.title === connectionData.title,
      );
      if (existing.length > 0) {
        const baseName = connectionData.title || "MCP Server";
        connectionData.title = `${baseName} (${existing.length + 1})`;
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
          // Still add to agent — user can auth later from agent page
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

      // Add to agent
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
            onInlineConnect={handleInlineConnect}
            connectingItemId={connectingItemId}
          />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}

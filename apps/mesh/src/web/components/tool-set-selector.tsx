import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { useInfiniteScroll } from "@/web/hooks/use-infinite-scroll";
import { KEYS } from "@/web/lib/query-keys";
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { ArrowLeft, Loading01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import type { CollectionListOutput } from "@decocms/bindings/collections";
import {
  type ConnectionEntity,
  parseVirtualUrl,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { memo, useDeferredValue, useRef, useState } from "react";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";

export interface ToolSetSelectorProps {
  toolSet: Record<string, string[]>;
  onToolSetChange: (toolSet: Record<string, string[]>) => void;
  /** Virtual MCP ID to exclude from selection (prevents self-reference) */
  excludeVirtualMcpId?: string;
  /** Controlled search query — if provided, hides the internal search bar */
  searchQuery?: string;
}

interface ConnectionItemProps {
  connection: {
    id: string;
    title: string;
    description?: string | null;
    icon?: string | null;
    tools?: Array<{ name: string }> | null;
  };
  isSelected: boolean;
  hasToolsEnabled: boolean;
  activeToolsCount: number;
  totalToolsCount: number;
  onSelect: () => void;
  onToggle: () => void;
}

const ConnectionItem = memo(function ConnectionItem({
  connection,
  isSelected,
  hasToolsEnabled,
  activeToolsCount,
  totalToolsCount,
  onSelect,
  onToggle,
}: ConnectionItemProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 p-2 rounded-lg transition-colors will-change-auto",
        isSelected ? "bg-accent/50" : "hover:bg-muted/50",
      )}
    >
      <div
        className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer"
        onClick={onSelect}
      >
        <IntegrationIcon
          icon={connection.icon}
          name={connection.title}
          size="xs"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {connection.title}
          </p>
        </div>
      </div>
      {connection.tools && connection.tools.length > 0 && (
        <>
          <span className="text-xs text-muted-foreground shrink-0">
            {activeToolsCount}/{totalToolsCount}
          </span>
          <Checkbox
            checked={hasToolsEnabled}
            onCheckedChange={onToggle}
            onClick={(e) => e.stopPropagation()}
          />
        </>
      )}
    </div>
  );
});

interface ToolItemProps {
  connectionId: string;
  tool: { name: string; description?: string };
  isSelected: boolean;
  onToggle: () => void;
}

const ToolItem = memo(function ToolItem({
  connectionId,
  tool,
  isSelected,
  onToggle,
}: ToolItemProps) {
  return (
    <label
      className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/50 cursor-pointer group will-change-auto"
      htmlFor={`tool-${connectionId}-${tool.name}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span
            className={cn(
              "text-sm font-medium",
              isSelected ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {tool.name}
          </span>
        </div>
        {tool.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {tool.description}
          </p>
        )}
      </div>
      <div className="flex items-center shrink-0">
        <Checkbox
          id={`tool-${connectionId}-${tool.name}`}
          checked={isSelected}
          onCheckedChange={onToggle}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    </label>
  );
});

type FilterMode = "all" | "selected" | "unselected";

export function ToolSetSelector({
  toolSet,
  onToolSetChange,
  excludeVirtualMcpId,
  searchQuery: controlledSearchQuery,
}: ToolSetSelectorProps) {
  const [internalSearchQuery, setInternalSearchQuery] = useState("");
  const searchQuery =
    controlledSearchQuery !== undefined
      ? controlledSearchQuery
      : internalSearchQuery;
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [showMobileDetail, setShowMobileDetail] = useState(false);
  const initialOrder = useRef<Set<string>>(new Set(Object.keys(toolSet)));

  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const PAGE_SIZE = 100;
  const trimmedSearch = deferredSearchQuery.trim();
  const where = trimmedSearch
    ? {
        operator: "or" as const,
        conditions: [
          {
            field: ["title"],
            operator: "contains" as const,
            value: trimmedSearch,
          },
          {
            field: ["description"],
            operator: "contains" as const,
            value: trimmedSearch,
          },
        ],
      }
    : undefined;

  const includeVirtual = !!excludeVirtualMcpId;
  const toolArguments = {
    ...(where && { where }),
    orderBy: [{ field: ["updated_at"], direction: "asc" as const }],
    limit: PAGE_SIZE,
    offset: 0,
    ...(includeVirtual && { include_virtual: true }),
  };
  const argsKey = JSON.stringify(toolArguments);

  const {
    data: connectionsData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
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
          ...(includeVirtual && { include_virtual: true }),
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

  const scrollSentinelRef = useInfiniteScroll(
    fetchNextPage,
    hasNextPage ?? false,
    isFetchingNextPage,
  );

  // Filter out the specific VIRTUAL connection that would cause self-reference
  const connections = excludeVirtualMcpId
    ? allConnections.filter((conn) => {
        if (conn.connection_type !== "VIRTUAL") return true;
        const virtualMcpId = parseVirtualUrl(conn.connection_url);
        return virtualMcpId !== excludeVirtualMcpId;
      })
    : allConnections;

  const initialOrderSet = initialOrder.current;

  // selected first
  const selected = [...initialOrderSet.values()]
    .map((id) => connections.find((c) => c.id === id))
    .filter((c) => c !== undefined);

  // then not selected
  const notSelected = connections.filter((c) => !initialOrderSet.has(c.id));

  const sortedConnections = [...selected, ...notSelected];

  // Check if connection has any tools enabled
  const isConnectionSelected = (connectionId: string): boolean => {
    const enabledTools = toolSet[connectionId];
    return enabledTools !== undefined && enabledTools.length > 0;
  };

  // Apply filter
  const filteredConnections = sortedConnections.filter((connection) => {
    if (filterMode === "all") return true;
    const hasTools = isConnectionSelected(connection.id);
    if (filterMode === "selected") return hasTools;
    if (filterMode === "unselected") return !hasTools;
    return true;
  });

  const [selectedConnectionId, setSelectedConnectionId] = useState<
    string | null
  >(sortedConnections[0]?.id ?? null);

  // Get selected connection
  const selectedConnection = selectedConnectionId
    ? (sortedConnections.find((c) => c.id === selectedConnectionId) ?? null)
    : null;

  // Get tools for selected connection
  const connectionTools = selectedConnection?.tools ?? [];

  // Check if specific tool is enabled
  const isToolSelected = (connectionId: string, toolName: string): boolean => {
    return toolSet[connectionId]?.includes(toolName) ?? false;
  };

  // Toggle a single tool
  const toggleTool = (connectionId: string, toolName: string) => {
    const currentTools = toolSet[connectionId] ?? [];
    const isSelected = currentTools.includes(toolName);

    const newToolSet = { ...toolSet };

    if (isSelected) {
      // Remove tool
      const updatedTools = currentTools.filter((t) => t !== toolName);
      if (updatedTools.length === 0) {
        // Remove connection entry if no tools left
        delete newToolSet[connectionId];
      } else {
        newToolSet[connectionId] = updatedTools;
      }
    } else {
      // Add tool
      newToolSet[connectionId] = [...currentTools, toolName];
    }

    onToolSetChange(newToolSet);
  };

  // Toggle all tools for a connection
  const toggleConnection = (connectionId: string) => {
    const connection = sortedConnections.find((c) => c.id === connectionId);
    if (!connection?.tools) return;

    const currentTools = toolSet[connectionId] ?? [];
    const allToolNames = connection.tools.map((t) => t.name);
    const allSelected =
      currentTools.length > 0 &&
      allToolNames.every((name) => currentTools.includes(name));

    const newToolSet = { ...toolSet };

    if (allSelected) {
      // Deselect all tools
      delete newToolSet[connectionId];
    } else {
      // Select all tools
      newToolSet[connectionId] = allToolNames;
      // Set this connection as the selected connection
      setSelectedConnectionId(connectionId);
    }

    onToolSetChange(newToolSet);
  };

  // Handle connection selection (mobile opens detail view)
  const handleConnectionSelect = (connectionId: string) => {
    setSelectedConnectionId(connectionId);
    setShowMobileDetail(true);
  };

  // Handle back button (mobile only)
  const handleMobileBack = () => {
    setShowMobileDetail(false);
  };

  return (
    <div className="flex h-full">
      {/* Left Column - Connections List (hidden on mobile when detail view is shown) */}
      <div
        className={cn(
          "w-full md:w-80 border-r border-border flex flex-col",
          showMobileDetail && "hidden md:flex",
        )}
      >
        {/* Search Input — hidden when controlled from outside */}
        {controlledSearchQuery === undefined && (
          <CollectionSearch
            value={internalSearchQuery}
            onChange={setInternalSearchQuery}
            placeholder="Search MCP Servers..."
          />
        )}

        {/* Filter Buttons */}
        <div className="flex gap-1 p-2 border-b border-border">
          <button
            onClick={() => setFilterMode("all")}
            className={cn(
              "flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors border cursor-pointer",
              filterMode === "all"
                ? "bg-muted border-border"
                : "border-border opacity-75 hover:opacity-100",
            )}
          >
            All
          </button>
          <button
            onClick={() => setFilterMode("selected")}
            className={cn(
              "flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors border cursor-pointer",
              filterMode === "selected"
                ? "bg-muted border-border"
                : "border-border opacity-75 hover:opacity-100",
            )}
          >
            Selected
          </button>
          <button
            onClick={() => setFilterMode("unselected")}
            className={cn(
              "flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors border cursor-pointer",
              filterMode === "unselected"
                ? "bg-muted border-border"
                : "border-border opacity-75 hover:opacity-100",
            )}
          >
            Unselected
          </button>
        </div>

        {/* Connections List */}
        <div className="flex-1 overflow-auto">
          {filteredConnections.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground text-center">
              {searchQuery
                ? "No connections found"
                : filterMode === "selected"
                  ? "No servers selected"
                  : filterMode === "unselected"
                    ? "No unselected servers"
                    : "No connections available"}
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {filteredConnections.map((connection) => {
                const totalTools = connection.tools?.length ?? 0;
                const activeTools = toolSet[connection.id]?.length ?? 0;

                return (
                  <ConnectionItem
                    key={connection.id}
                    connection={connection}
                    isSelected={selectedConnectionId === connection.id}
                    hasToolsEnabled={isConnectionSelected(connection.id)}
                    activeToolsCount={activeTools}
                    totalToolsCount={totalTools}
                    onSelect={() => handleConnectionSelect(connection.id)}
                    onToggle={() => toggleConnection(connection.id)}
                  />
                );
              })}
              {/* Infinite scroll sentinel */}
              <div ref={scrollSentinelRef} className="h-4" />
              {isFetchingNextPage && (
                <div className="flex justify-center py-3">
                  <Loading01
                    size={18}
                    className="animate-spin text-muted-foreground"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right Column - Tools List (full width on mobile when shown) */}
      <div
        className={cn(
          "flex-1 flex-col",
          showMobileDetail ? "flex" : "hidden md:flex",
        )}
      >
        {selectedConnection ? (
          <>
            {/* Mobile Header with Back Button */}
            <div className="md:hidden border-b border-border p-4 flex items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleMobileBack}
                className="h-8 w-8 p-0 shrink-0"
              >
                <ArrowLeft size={20} />
              </Button>
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <IntegrationIcon
                  icon={selectedConnection.icon}
                  name={selectedConnection.title}
                  size="sm"
                />
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-medium text-foreground truncate">
                    {selectedConnection.title}
                  </h3>
                  {selectedConnection.description && (
                    <p className="text-sm text-muted-foreground truncate">
                      {selectedConnection.description}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Tools List */}
            <div className="flex-1 overflow-auto p-4">
              {connectionTools.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-8">
                  This connection has no tools available
                </div>
              ) : (
                <div className="space-y-2">
                  {connectionTools.map((tool) => (
                    <ToolItem
                      key={tool.name}
                      connectionId={selectedConnection.id}
                      tool={tool}
                      isSelected={isToolSelected(
                        selectedConnection.id,
                        tool.name,
                      )}
                      onToggle={() =>
                        toggleTool(selectedConnection.id, tool.name)
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-sm text-muted-foreground text-center">
              Select a connection to view its tools
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

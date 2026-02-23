import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  Inbox01,
  SearchMd,
  Loading01,
  FilterLines,
  RefreshCw01,
} from "@untitledui/icons";
import { useDebounce } from "@/web/hooks/use-debounce";
import { useScrollRestoration } from "@/web/hooks/use-scroll-restoration";
import { useStoreDiscovery } from "@/web/hooks/use-store-discovery";
import {
  ORG_ADMIN_PROJECT_SLUG,
  useConnection,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { slugify } from "@/web/utils/slugify";
import {
  findListToolName,
  findFiltersToolName,
} from "@/web/utils/registry-utils";
import { CollectionSearch } from "../collections/collection-search";
import { MCPServerCardGrid } from "./mcp-server-card";
import { StoreFilters } from "./store-filters";
import { Button } from "@deco/ui/components/button.tsx";
import type { RegistryItem } from "./types";

interface StoreDiscoveryProps {
  registryId: string;
  storePrivateOnly?: boolean;
}

/**
 * Filter items by search term across name and description
 * Note: Search is done client-side for instant feedback
 */
function filterItemsBySearch(
  items: RegistryItem[],
  search: string,
): RegistryItem[] {
  if (!search) return items;
  const searchLower = search.toLowerCase();
  return items.filter(
    (item) =>
      (item.name || item.title || "").toLowerCase().includes(searchLower) ||
      (item.description || item.server?.description || "")
        .toLowerCase()
        .includes(searchLower),
  );
}

/**
 * Check if an item is verified
 */
function isItemVerified(item: RegistryItem): boolean {
  return item.verified === true || item._meta?.["mcp.mesh"]?.verified === true;
}

/**
 * Store discovery content - handles data display and interactions
 */
function StoreDiscoveryContent({
  registryId,
  listToolName,
  filtersToolName,
  storePrivateOnly,
}: {
  registryId: string;
  listToolName: string;
  filtersToolName?: string;
  storePrivateOnly?: boolean;
}) {
  const [search, setSearch] = useState("");
  // Debounce search for server-side query (300ms delay to rate-limit API calls)
  const debouncedSearch = useDebounce(search, 300);
  const navigate = useNavigate();
  const { org } = useProjectContext();

  // Preserve scroll position across navigation
  const {
    scrollRef,
    saveScrollPosition,
    handleScroll: handleScrollRestore,
  } = useScrollRestoration(`store-discovery:${registryId}`);

  const {
    items,
    hasMore,
    isLoadingMore,
    isInitialLoading,
    isFetching,
    error,
    loadMore,
    availableTags,
    availableCategories,
    selectedTags,
    selectedCategories,
    setSelectedTags,
    setSelectedCategories,
    hasActiveFilters,
  } = useStoreDiscovery({
    registryId,
    listToolName,
    filtersToolName,
    search: debouncedSearch,
  });

  // Always apply local filter when search is active
  // This ensures instant feedback and handles keepPreviousData showing unfiltered cached data
  const filteredItems = search ? filterItemsBySearch(items, search) : items;
  const visibleItems = storePrivateOnly
    ? filteredItems.filter((item) => item.is_public !== true)
    : filteredItems;

  // Show searching indicator when server-side search is pending or fetching
  const isSearching =
    (search !== debouncedSearch || isFetching) &&
    !isInitialLoading &&
    Boolean(search);

  // Separate verified and non-verified items
  const verifiedItems = visibleItems.filter(isItemVerified);
  const allItems = visibleItems.filter(
    (item) => !verifiedItems.find((v) => v.id === item.id),
  );

  const handleItemClick = (item: RegistryItem) => {
    // Save scroll position before navigating
    saveScrollPosition();

    const serverSlug = slugify(
      item.name || item.title || item.server?.title || "",
    );
    // Keep compatibility across registries:
    // - Prefer scoped item IDs (e.g. "deco/google-drive") when server.name is not scoped.
    // - Otherwise keep server.name-first behavior used by most stores.
    const idIsScoped = typeof item.id === "string" && item.id.includes("/");
    const serverNameIsScoped =
      typeof item.server?.name === "string" && item.server.name.includes("/");
    const serverName =
      idIsScoped && !serverNameIsScoped
        ? item.id
        : item.server?.name || item.id || "";

    navigate({
      to: "/$org/$project/store/$appName",
      params: {
        org: org.slug,
        project: ORG_ADMIN_PROJECT_SLUG,
        appName: serverSlug,
      },
      search: {
        registryId,
        serverName,
      },
    });
  };

  // Infinite scroll: load more when near bottom
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    // Restore scroll position if needed
    handleScrollRestore();

    if (!hasMore || isLoadingMore) return;

    const target = e.currentTarget;
    const scrollBottom =
      target.scrollHeight - target.scrollTop - target.clientHeight;

    // Load more when within 200px of bottom
    if (scrollBottom < 200) {
      loadMore();
    }
  };

  return (
    <div className="flex flex-col h-full">
      <CollectionSearch
        value={search}
        onChange={setSearch}
        placeholder="Search for an MCP Server..."
        isSearching={isSearching}
      />

      {/* Filters */}
      <StoreFilters
        availableTags={availableTags}
        availableCategories={availableCategories}
        selectedTags={selectedTags}
        selectedCategories={selectedCategories}
        onTagChange={setSelectedTags}
        onCategoryChange={setSelectedCategories}
      />

      {/* Content */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        onScroll={handleScroll}
      >
        <div className="p-5">
          <div>
            {/* Error state — registry unreachable */}
            {error && !isInitialLoading ? (
              <div className="flex flex-col items-center justify-center py-12 text-center space-y-4">
                <div className="bg-destructive/10 p-3 rounded-full">
                  <AlertTriangle className="size-8 text-destructive" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-lg font-medium">Registry unavailable</h3>
                  <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                    Could not load items from this registry. It may be
                    temporarily offline.
                  </p>
                  {error.message && (
                    <p className="text-xs text-muted-foreground/60 font-mono max-w-md mx-auto truncate">
                      {error.message}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.location.reload()}
                >
                  <RefreshCw01 className="size-4" />
                  Try again
                </Button>
              </div>
            ) : /* Initial loading state */
            isInitialLoading ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Loading01
                  size={32}
                  className="animate-spin text-muted-foreground mb-4"
                />
                <p className="text-sm text-muted-foreground">
                  Loading items...
                </p>
              </div>
            ) : visibleItems.length === 0 && !hasActiveFilters ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Inbox01 size={48} className="text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">No items available</h3>
                <p className="text-muted-foreground">
                  This store doesn't have any available items yet.
                </p>
              </div>
            ) : visibleItems.length === 0 && hasActiveFilters && !search ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <FilterLines size={48} className="text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">No matching items</h3>
                <p className="text-muted-foreground">
                  Try adjusting your filters to find more results.
                </p>
              </div>
            ) : search && visibleItems.length === 0 && !isSearching ? (
              // Only show "No results" when search is complete (not while searching)
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <SearchMd size={48} className="text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">No results found</h3>
                <p className="text-muted-foreground">
                  Try adjusting your search terms.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-8">
                {/* Searching indicator when no local results yet */}
                {isSearching && visibleItems.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <Loading01
                      size={32}
                      className="animate-spin text-muted-foreground mb-4"
                    />
                    <p className="text-sm text-muted-foreground">
                      Searching...
                    </p>
                  </div>
                )}

                {verifiedItems.length > 0 && (
                  <MCPServerCardGrid
                    items={verifiedItems}
                    title="Verified"
                    onItemClick={handleItemClick}
                  />
                )}

                {allItems.length > 0 && (
                  <MCPServerCardGrid
                    items={allItems}
                    title={verifiedItems.length > 0 ? "All" : ""}
                    onItemClick={handleItemClick}
                  />
                )}

                {/* Loading more indicator */}
                {hasMore && isLoadingMore && (
                  <div className="flex justify-center py-8">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Loading01 size={20} className="animate-spin" />
                      <span className="text-sm">Loading more items...</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Store Discovery - main entry point
 * Discovers available tools and renders the discovery UI
 */
export function StoreDiscovery({
  registryId,
  storePrivateOnly,
}: StoreDiscoveryProps) {
  const registryConnection = useConnection(registryId);

  // Find the LIST tool from the registry connection
  const listToolName = findListToolName(registryConnection?.tools);
  if (!listToolName) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-12 text-center space-y-4">
        <div className="bg-muted p-3 rounded-full">
          <Inbox01 className="size-8 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-medium">Registry not available</h3>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            This registry does not support listing store items, or the
            connection is not responding.
          </p>
        </div>
      </div>
    );
  }

  // Find the FILTERS tool (optional - not all registries support it)
  const filtersToolName = findFiltersToolName(registryConnection?.tools);

  return (
    <StoreDiscoveryContent
      registryId={registryId}
      listToolName={listToolName}
      filtersToolName={filtersToolName || undefined}
      storePrivateOnly={storePrivateOnly}
    />
  );
}

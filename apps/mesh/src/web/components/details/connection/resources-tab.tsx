import { CollectionDisplayButton } from "@/web/components/collections/collection-display-button.tsx";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { CollectionTableWrapper } from "@/web/components/collections/collection-table-wrapper.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import { useState } from "react";
import { ViewActions } from "@/web/components/details/layout";

/** Resource type for display - compatible with MCP Resource but with optional name */
interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface ResourcesListProps {
  /** Array of resources to display */
  resources: McpResource[] | undefined;
  /** Connection ID for context */
  connectionId?: string;
  /** Organization slug for context */
  org?: string;
  /** Custom click handler */
  onResourceClick?: (resource: McpResource) => void;
  /** Whether to show the ViewActions toolbar (default: true) */
  showToolbar?: boolean;
  /** Custom empty state message */
  emptyMessage?: string;
}

/**
 * Shared component for displaying a list of resources with search, sort, and view modes.
 */
function ResourcesList({
  resources,
  onResourceClick,
  showToolbar = true,
  emptyMessage = "This connection doesn't have any resources yet.",
}: ResourcesListProps) {
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");
  const [sortKey, setSortKey] = useState<string | undefined>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc" | null>(
    "asc",
  );

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDirection((prev) =>
        prev === "asc" ? "desc" : prev === "desc" ? null : "asc",
      );
      if (sortDirection === "desc") setSortKey(undefined);
    } else {
      setSortKey(key);
      setSortDirection("asc");
    }
  };

  const handleResourceClick = (resource: McpResource) => {
    if (onResourceClick) {
      onResourceClick(resource);
    }
  };

  const filteredResources =
    !resources || resources.length === 0
      ? []
      : !search.trim()
        ? resources
        : (() => {
            const searchLower = search.toLowerCase();
            return resources.filter(
              (r) =>
                r.uri.toLowerCase().includes(searchLower) ||
                (r.name && r.name.toLowerCase().includes(searchLower)) ||
                (r.description &&
                  r.description.toLowerCase().includes(searchLower)),
            );
          })();

  const sortedResources =
    !sortKey || !sortDirection
      ? filteredResources
      : [...filteredResources].sort((a, b) => {
          const aVal = (a as unknown as Record<string, unknown>)[sortKey] || "";
          const bVal = (b as unknown as Record<string, unknown>)[sortKey] || "";
          const comparison = String(aVal).localeCompare(String(bVal));
          return sortDirection === "asc" ? comparison : -comparison;
        });

  const columns = [
    {
      id: "name",
      header: "Name",
      render: (resource: McpResource) => (
        <span className="text-sm font-medium text-foreground">
          {resource.name || resource.uri}
        </span>
      ),
      sortable: true,
    },
    {
      id: "uri",
      header: "URI",
      render: (resource: McpResource) => (
        <span className="text-sm font-mono text-muted-foreground">
          {resource.uri}
        </span>
      ),
      sortable: true,
    },
    {
      id: "description",
      header: "Description",
      render: (resource: McpResource) => (
        <span className="text-sm text-foreground">
          {resource.description || "—"}
        </span>
      ),
      cellClassName: "flex-1",
      sortable: true,
    },
    {
      id: "mimeType",
      header: "Type",
      render: (resource: McpResource) => (
        <span className="text-sm text-muted-foreground">
          {resource.mimeType || "—"}
        </span>
      ),
      sortable: true,
    },
  ];

  const sortOptions = columns
    .filter((col) => col.sortable)
    .map((col) => ({
      id: col.id,
      label: typeof col.header === "string" ? col.header : col.id,
    }));

  return (
    <>
      {showToolbar && (
        <ViewActions>
          <CollectionDisplayButton
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={handleSort}
            sortOptions={sortOptions}
          />
        </ViewActions>
      )}

      <div className="flex flex-col h-full overflow-hidden">
        {/* Search */}
        <CollectionSearch
          value={search}
          onChange={setSearch}
          placeholder="Search resources..."
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setSearch("");
              (event.target as HTMLInputElement).blur();
            }
          }}
        />

        {/* Content: Cards or Table */}
        {viewMode === "cards" ? (
          <div className="flex-1 overflow-auto p-5">
            {sortedResources.length === 0 ? (
              <EmptyState
                image={null}
                title={search ? "No resources found" : "No resources available"}
                description={
                  search ? "Try adjusting your search terms" : emptyMessage
                }
              />
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
                {sortedResources.map((resource) => (
                  <Card
                    key={resource.uri}
                    className="cursor-pointer transition-colors"
                    onClick={() => handleResourceClick(resource)}
                  >
                    <div className="flex flex-col gap-4 p-6">
                      <IntegrationIcon
                        icon={null}
                        name={resource.name || resource.uri}
                        size="md"
                        className="shrink-0 shadow-sm"
                      />
                      <div className="flex flex-col gap-1">
                        <h3 className="text-base font-medium text-foreground truncate">
                          {resource.name || resource.uri}
                        </h3>
                        <p className="text-xs font-mono text-muted-foreground truncate">
                          {resource.uri}
                        </p>
                        {resource.description && (
                          <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                            {resource.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        ) : (
          <CollectionTableWrapper
            columns={columns}
            data={sortedResources}
            isLoading={false}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={handleSort}
            onRowClick={(resource: McpResource) =>
              handleResourceClick(resource)
            }
            emptyState={
              <EmptyState
                image={null}
                title={search ? "No resources found" : "No resources available"}
                description={
                  search ? "Try adjusting your search terms" : emptyMessage
                }
              />
            }
          />
        )}
      </div>
    </>
  );
}

interface ResourcesTabProps {
  resources: McpResource[] | undefined;
  connectionId: string;
  org: string;
}

export function ResourcesTab({
  resources,
  connectionId,
  org,
}: ResourcesTabProps) {
  return (
    <ResourcesList
      resources={resources}
      connectionId={connectionId}
      org={org}
    />
  );
}

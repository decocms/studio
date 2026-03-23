import { CollectionDisplayButton } from "@/web/components/collections/collection-display-button.tsx";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { CollectionTableWrapper } from "@/web/components/collections/collection-table-wrapper.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { getUIResourceUri } from "@/mcp-apps/types.ts";
import type { ToolDefinition } from "@decocms/mesh-sdk";
import {
  AlertTriangle,
  Eye,
  Globe02,
  LayersTwo01,
  RefreshCw01,
} from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ViewActions } from "@/web/components/details/layout";

export interface Tool {
  name: string;
  description?: string;
  annotations?: ToolDefinition["annotations"];
  _meta?: Record<string, unknown>;
}

const ANNOTATION_HINTS = [
  { key: "readOnlyHint", label: "Read-only", Icon: Eye, variant: "secondary" },
  {
    key: "destructiveHint",
    label: "Destructive",
    Icon: AlertTriangle,
    variant: "destructive",
  },
  {
    key: "idempotentHint",
    label: "Idempotent",
    Icon: RefreshCw01,
    variant: "secondary",
  },
  {
    key: "openWorldHint",
    label: "Open-world",
    Icon: Globe02,
    variant: "outline",
  },
] as const;

export function ToolAnnotationBadges({
  annotations,
  _meta,
}: {
  annotations?: ToolDefinition["annotations"];
  _meta?: Record<string, unknown>;
}) {
  const hasUI = !!getUIResourceUri(_meta);
  const active = annotations
    ? ANNOTATION_HINTS.filter((h) => annotations[h.key] === true)
    : [];
  if (active.length === 0 && !hasUI) return null;
  return (
    <TooltipProvider>
      <div className="flex gap-1 flex-nowrap">
        {hasUI && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge asChild variant="secondary" className="size-6 p-1">
                <LayersTwo01 />
              </Badge>
            </TooltipTrigger>
            <TooltipContent>Interactive</TooltipContent>
          </Tooltip>
        )}
        {active.map(({ label, Icon, variant }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <Badge asChild variant={variant} className="size-6 p-1">
                <Icon />
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}

export interface ToolsListProps {
  /** Array of tools to display */
  tools: Tool[] | undefined;
  /** Connection ID for navigation */
  connectionId?: string;
  /** Organization slug for navigation */
  org?: string;
  /** Custom click handler - if provided, overrides default navigation */
  onToolClick?: (tool: Tool) => void;
  /** Whether to show the ViewActions toolbar (default: true) */
  showToolbar?: boolean;
  /** Custom empty state message */
  emptyMessage?: string;
  /** Whether tools are being loaded */
  isLoading?: boolean;
}

/**
 * Shared component for displaying a list of tools with search, sort, and view modes.
 * Can be used in both connection detail and store server detail pages.
 */
export function ToolsList({
  tools,
  connectionId,
  org,
  onToolClick,
  showToolbar = true,
  emptyMessage = "This connection doesn't have any tools yet.",
  isLoading = false,
}: ToolsListProps) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [viewMode] = useState<"table" | "cards">("table");
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

  const handleToolClick = (tool: Tool) => {
    if (onToolClick) {
      onToolClick(tool);
    } else if (connectionId && org) {
      navigate({
        to: "/$org/mcps/$connectionId/$collectionName/$itemId",
        params: {
          org: org,
          connectionId: connectionId,
          collectionName: "tools",
          itemId: encodeURIComponent(tool.name),
        },
      });
    }
  };

  const filteredTools =
    !tools || tools.length === 0
      ? []
      : !search.trim()
        ? tools
        : (() => {
            const searchLower = search.toLowerCase();
            return tools.filter(
              (t) =>
                t.name.toLowerCase().includes(searchLower) ||
                (t.description &&
                  t.description.toLowerCase().includes(searchLower)),
            );
          })();

  const sortedTools =
    !sortKey || !sortDirection
      ? filteredTools
      : [...filteredTools].sort((a, b) => {
          const aVal = (a as unknown as Record<string, unknown>)[sortKey] || "";
          const bVal = (b as unknown as Record<string, unknown>)[sortKey] || "";
          const comparison = String(aVal).localeCompare(String(bVal));
          return sortDirection === "asc" ? comparison : -comparison;
        });

  const columns = [
    {
      id: "name",
      header: "Name",
      render: (tool: Tool) => (
        <span className="text-sm font-medium font-mono text-foreground">
          {tool.name}
        </span>
      ),
      sortable: true,
    },
    {
      id: "annotations",
      header: "Hints",
      render: (tool: Tool) => (
        <ToolAnnotationBadges
          annotations={tool.annotations}
          _meta={tool._meta}
        />
      ),
      cellClassName: "w-32 shrink-0",
    },
    {
      id: "description",
      header: "Description",
      render: (tool: Tool) => (
        <span className="text-sm text-foreground">
          {tool.description || "—"}
        </span>
      ),
      cellClassName: "flex-1",
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
          placeholder="Search tools..."
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
            {sortedTools.length === 0 ? (
              <EmptyState
                image={null}
                title={search ? "No tools found" : "No tools available"}
                description={
                  search ? "Try adjusting your search terms" : emptyMessage
                }
              />
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
                {sortedTools.map((tool) => (
                  <Card
                    key={tool.name}
                    className="cursor-pointer transition-colors"
                    onClick={() => handleToolClick(tool)}
                  >
                    <div className="flex flex-col gap-4 p-6">
                      <IntegrationIcon
                        icon={null}
                        name={tool.name}
                        size="md"
                        className="shrink-0 shadow-sm"
                      />
                      <div className="flex flex-col gap-0">
                        <h3 className="text-base font-medium text-foreground truncate">
                          {tool.name}
                        </h3>
                        <p className="text-base text-muted-foreground line-clamp-2">
                          {tool.description || "No description"}
                        </p>
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
            data={sortedTools}
            isLoading={isLoading}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={handleSort}
            onRowClick={(tool: Tool) => handleToolClick(tool)}
            emptyState={
              <EmptyState
                image={null}
                title={search ? "No tools found" : "No tools available"}
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

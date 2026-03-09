import { useDeferredValue, useRef, useState } from "react";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@deco/ui/components/toggle-group.tsx";
import { useViewMode } from "@deco/ui/hooks/use-view-mode.ts";
import { toast } from "sonner";
import {
  DotsVertical,
  FilterLines,
  Globe01,
  Loading01,
  SearchMd,
} from "@untitledui/icons";
import { PLUGIN_ID } from "../../shared";
import { CsvImportDialog } from "./csv-import-dialog";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";
import { RegistryItemCard } from "./registry-item-card";
import { RegistryItemDialog } from "./registry-item-dialog";
import {
  useRegistryConfig,
  useRegistryFilters,
  useRegistryItems,
  useRegistryMutations,
} from "../hooks/use-registry";
import type {
  RegistryCreateInput,
  RegistryItem,
  RegistryUpdateInput,
} from "../lib/types";

function toggleSelection(list: string[], value: string): string[] {
  return list.includes(value)
    ? list.filter((current) => current !== value)
    : [...list, value];
}

function extractTags(item: RegistryItem): string[] {
  return item._meta?.["mcp.mesh"]?.tags ?? [];
}

function extractCategories(item: RegistryItem): string[] {
  return item._meta?.["mcp.mesh"]?.categories ?? [];
}

function extractRemoteUrl(item: RegistryItem): string {
  return item.server?.remotes?.[0]?.url ?? "-";
}

export default function RegistryItemsPage() {
  const toolbarButtonClass = "h-8";

  const [searchInput, setSearchInput] = useState("");
  const search = useDeferredValue(searchInput);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<RegistryItem | null>(null);
  const [deletingItem, setDeletingItem] = useState<RegistryItem | null>(null);
  const [viewMode, setViewMode] = useViewMode("private-registry-list", "cards");
  const observerRef = useRef<IntersectionObserver | null>(null);

  const itemsQuery = useRegistryItems({
    search,
    tags: selectedTags,
    categories: selectedCategories,
  });
  const filtersQuery = useRegistryFilters();
  const { registryLLMConnectionId, registryLLMModelId } =
    useRegistryConfig(PLUGIN_ID);
  const { createMutation, updateMutation, deleteMutation, bulkCreateMutation } =
    useRegistryMutations();

  const items =
    itemsQuery.data?.pages
      .flatMap((page) => page.items ?? [])
      .filter(Boolean) ?? [];
  const totalCount = itemsQuery.data?.pages[0]?.totalCount ?? items.length;
  const hasActiveFilters =
    selectedTags.length > 0 ||
    selectedCategories.length > 0 ||
    search.length > 0;
  const filters = filtersQuery.data;
  const tags = Array.isArray(filters?.tags) ? filters.tags : [];
  const categories = Array.isArray(filters?.categories)
    ? filters.categories
    : [];

  const setLoadMoreSentinel = (node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (!node || !itemsQuery.hasNextPage || itemsQuery.isFetchingNextPage) {
      return;
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (
          entry?.isIntersecting &&
          itemsQuery.hasNextPage &&
          !itemsQuery.isFetchingNextPage
        ) {
          void itemsQuery.fetchNextPage();
        }
      },
      { rootMargin: "240px 0px" },
    );

    observerRef.current.observe(node);
  };

  const handleCreateOrEdit = async (
    payload: RegistryCreateInput | { id: string; data: RegistryUpdateInput },
  ) => {
    try {
      if ("data" in payload) {
        await updateMutation.mutateAsync(payload);
        toast.success("Registry item updated");
      } else {
        await createMutation.mutateAsync(payload);
        toast.success("Registry item created");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save item",
      );
      throw error;
    }
  };

  const handleToggleVerified = async (item: RegistryItem) => {
    const currentVerified = item._meta?.["mcp.mesh"]?.verified === true;
    try {
      await updateMutation.mutateAsync({
        id: item.id,
        data: {
          _meta: {
            ...item._meta,
            "mcp.mesh": {
              ...item._meta?.["mcp.mesh"],
              verified: !currentVerified,
            },
          },
        },
      });
      toast.success(
        currentVerified ? "Removed verified status" : "Marked as verified",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update item",
      );
    }
  };

  const handleToggleOfficial = async (item: RegistryItem) => {
    const currentOfficial = item._meta?.["mcp.mesh"]?.official === true;
    try {
      await updateMutation.mutateAsync({
        id: item.id,
        data: {
          _meta: {
            ...item._meta,
            "mcp.mesh": {
              ...item._meta?.["mcp.mesh"],
              official: !currentOfficial,
            },
          },
        },
      });
      toast.success(
        currentOfficial ? "Removed official status" : "Marked as official",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update item",
      );
    }
  };

  const handleDelete = async () => {
    if (!deletingItem) return;
    try {
      await deleteMutation.mutateAsync(deletingItem.id);
      toast.success("Registry item deleted");
      setDeletingItem(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete item",
      );
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 border-b border-border">
        <div className="h-12 px-4 md:px-6 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-sm font-medium">Items</h2>
            <Badge variant="secondary" className="text-xs">
              {totalCount}
            </Badge>
          </div>
          <div className="flex items-center gap-2 self-stretch">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(toolbarButtonClass, "gap-1.5")}
                >
                  <FilterLines size={14} />
                  Filters
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[260px]">
                <DropdownMenuLabel>Tags</DropdownMenuLabel>
                {tags.length > 0 ? (
                  tags.map((tag) => (
                    <DropdownMenuCheckboxItem
                      key={tag.value}
                      checked={selectedTags.includes(tag.value)}
                      onCheckedChange={() =>
                        setSelectedTags((current) =>
                          toggleSelection(current, tag.value),
                        )
                      }
                    >
                      {tag.value} ({tag.count})
                    </DropdownMenuCheckboxItem>
                  ))
                ) : (
                  <DropdownMenuItem disabled>
                    No tags available
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Categories</DropdownMenuLabel>
                {categories.length > 0 ? (
                  categories.map((category) => (
                    <DropdownMenuCheckboxItem
                      key={category.value}
                      checked={selectedCategories.includes(category.value)}
                      onCheckedChange={() =>
                        setSelectedCategories((current) =>
                          toggleSelection(current, category.value),
                        )
                      }
                    >
                      {category.value} ({category.count})
                    </DropdownMenuCheckboxItem>
                  ))
                ) : (
                  <DropdownMenuItem disabled>
                    No categories available
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <ToggleGroup
              type="single"
              value={viewMode}
              onValueChange={(value) => {
                if (value === "cards" || value === "table") {
                  setViewMode(value);
                }
              }}
              variant="outline"
              className={toolbarButtonClass}
            >
              <ToggleGroupItem
                value="cards"
                aria-label="Cards view"
                className={toolbarButtonClass}
              >
                Cards
              </ToggleGroupItem>
              <ToggleGroupItem
                value="table"
                aria-label="Table view"
                className={toolbarButtonClass}
              >
                Table
              </ToggleGroupItem>
            </ToggleGroup>

            <Button
              variant="outline"
              size="sm"
              className={toolbarButtonClass}
              onClick={() => setCsvOpen(true)}
            >
              Import CSV
            </Button>
            <Button
              size="sm"
              className={toolbarButtonClass}
              onClick={() => setCreateOpen(true)}
            >
              Add MCP Servers
            </Button>
          </div>
        </div>

        <div className="border-t border-border h-12 px-4 md:px-6 flex items-center">
          <label className="flex items-center gap-2.5 h-12 w-full cursor-text">
            <SearchMd size={16} className="text-muted-foreground shrink-0" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search by id, title, description, or server name"
              className="flex-1 border-0 shadow-none focus-visible:ring-0 px-0 h-full text-sm placeholder:text-muted-foreground/50 bg-transparent"
            />
          </label>
        </div>

        {hasActiveFilters && (
          <div className="border-t border-border px-4 md:px-6 py-2 flex flex-wrap items-center gap-2">
            {selectedTags.map((tag) => (
              <Badge key={`selected-tag-${tag}`} variant="default">
                #{tag}
              </Badge>
            ))}
            {selectedCategories.map((category) => (
              <Badge key={`selected-category-${category}`} variant="outline">
                {category}
              </Badge>
            ))}
            {searchInput.trim() && (
              <Badge variant="secondary" className="max-w-[280px] truncate">
                Search: {searchInput}
              </Badge>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 ml-auto"
              onClick={() => {
                setSearchInput("");
                setSelectedTags([]);
                setSelectedCategories([]);
              }}
            >
              Clear filters
            </Button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-4 md:px-6 py-4">
        {items.length === 0 ? (
          <div className="min-h-[320px] rounded-xl border border-dashed border-border flex flex-col items-center justify-center gap-3 p-6 text-center">
            {itemsQuery.isLoading ? (
              <>
                <Loading01 className="size-5 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Loading items...
                </p>
              </>
            ) : (
              <>
                <h3 className="text-base font-medium">
                  {hasActiveFilters
                    ? "No items found"
                    : "No MCPs in your registry"}
                </h3>
                <p className="text-sm text-muted-foreground max-w-md">
                  {hasActiveFilters
                    ? "Try removing filters or changing your search to find matching MCPs."
                    : "Add your first MCP item to start building your private registry catalog."}
                </p>
                {!hasActiveFilters && (
                  <Button size="lg" onClick={() => setCreateOpen(true)}>
                    Add MCP Servers
                  </Button>
                )}
              </>
            )}
          </div>
        ) : viewMode === "cards" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {items.map((item) => (
                <RegistryItemCard
                  key={item.id}
                  item={item}
                  onEdit={setEditingItem}
                  onDelete={setDeletingItem}
                  onToggleVerified={handleToggleVerified}
                  onToggleOfficial={handleToggleOfficial}
                />
              ))}
            </div>
            {itemsQuery.hasNextPage && (
              <div ref={setLoadMoreSentinel} className="h-2" />
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="border rounded-lg overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[56px]">Icon</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>ID</TableHead>
                    <TableHead>Tags</TableHead>
                    <TableHead>Categories</TableHead>
                    <TableHead>Remote URL</TableHead>
                    <TableHead>Visibility</TableHead>
                    <TableHead className="text-right w-[68px]">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="size-8 rounded-md border border-border bg-muted/20 overflow-hidden flex items-center justify-center">
                          {item.server?.icons?.[0]?.src ? (
                            <img
                              src={item.server.icons[0].src}
                              alt={item.title}
                              className="h-full w-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <span className="text-[10px] font-semibold text-muted-foreground">
                              {item.title.charAt(0).toUpperCase()}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{item.title}</TableCell>
                      <TableCell className="font-mono">{item.id}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {extractTags(item)
                            .slice(0, 3)
                            .map((tag) => (
                              <Badge
                                key={`${item.id}-tag-${tag}`}
                                variant="outline"
                              >
                                {tag}
                              </Badge>
                            ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {extractCategories(item)
                            .slice(0, 3)
                            .map((category) => (
                              <Badge
                                key={`${item.id}-category-${category}`}
                                variant="outline"
                              >
                                {category}
                              </Badge>
                            ))}
                        </div>
                      </TableCell>
                      <TableCell>{extractRemoteUrl(item)}</TableCell>
                      <TableCell>
                        {item.is_public ? (
                          <Badge variant="default" className="gap-1">
                            <Globe01 size={10} />
                            Public
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Private</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0"
                            >
                              <DotsVertical size={18} />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => setEditingItem(item)}
                            >
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setDeletingItem(item)}
                            >
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {itemsQuery.hasNextPage && (
              <div ref={setLoadMoreSentinel} className="h-2" />
            )}
          </div>
        )}

        {itemsQuery.isFetchingNextPage && (
          <div className="py-4 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loading01 className="size-4 animate-spin" />
            Loading more items...
          </div>
        )}
      </div>

      <RegistryItemDialog
        key={editingItem?.id ?? "create"}
        open={createOpen || Boolean(editingItem)}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setEditingItem(null);
          }
        }}
        item={editingItem}
        availableTags={tags.map((tag) => tag.value)}
        availableCategories={categories.map((category) => category.value)}
        defaultLLMConnectionId={registryLLMConnectionId}
        defaultLLMModelId={registryLLMModelId}
        isSubmitting={createMutation.isPending || updateMutation.isPending}
        onSubmit={handleCreateOrEdit}
      />

      <CsvImportDialog
        open={csvOpen}
        onOpenChange={setCsvOpen}
        isImporting={bulkCreateMutation.isPending}
        onImport={async (parsedItems) => {
          try {
            const result = await bulkCreateMutation.mutateAsync(parsedItems);
            toast.success(`Imported ${result.created} item(s)`);
            return result;
          } catch (error) {
            toast.error(
              error instanceof Error ? error.message : "Failed to import CSV",
            );
            throw error;
          }
        }}
      />

      <DeleteConfirmDialog
        open={Boolean(deletingItem)}
        onOpenChange={(open) => {
          if (!open) setDeletingItem(null);
        }}
        title={deletingItem?.title ?? deletingItem?.id ?? ""}
        isDeleting={deleteMutation.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}

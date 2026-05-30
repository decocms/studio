import { generatePrefixedId } from "@/shared/utils/generate-id";
import { CollectionDisplayButton } from "@/web/components/collections/collection-display-button.tsx";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import {
  CollectionsList,
  generateSortOptionsFromSchema,
} from "@/web/components/collections/collections-list.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";
import type { ValidatedCollection } from "@/web/hooks/use-binding";
import { useListState } from "@/web/hooks/use-list-state";
import { authClient } from "@/web/lib/auth-client";
import { BaseCollectionJsonSchema } from "@/web/utils/constants";
import { getConnectionSlug } from "@/shared/utils/connection-slug";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import type { BaseCollectionEntity } from "@decocms/bindings/collections";
import {
  useCollectionActions,
  useCollectionList,
  useConnection,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";
import { ViewActions } from "../layout";

interface CollectionTabProps {
  connectionId: string;
  org: string;
  activeCollection: ValidatedCollection;
  onItemClick?: (item: BaseCollectionEntity) => void;
}

export function CollectionTab({
  connectionId,
  org,
  activeCollection,
  onItemClick,
}: CollectionTabProps) {
  const collectionName = activeCollection.name;
  const schema = activeCollection.schema ?? BaseCollectionJsonSchema;
  const hasCreateTool = activeCollection.hasCreateTool;
  const hasUpdateTool = activeCollection.hasUpdateTool;
  const hasDeleteTool = activeCollection.hasDeleteTool;
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id || "unknown";
  const connectionData = useConnection(connectionId);
  const appSlug = connectionData
    ? getConnectionSlug(connectionData)
    : connectionId;

  const { org: projectOrg } = useProjectContext();
  const client = useMCPClient({
    connectionId,
    orgId: projectOrg.id,
    orgSlug: projectOrg.slug,
  });

  const actions = useCollectionActions<BaseCollectionEntity>(
    connectionId,
    collectionName,
    client,
  );

  const {
    search,
    searchTerm,
    setSearch,
    viewMode,
    setViewMode,
    sortKey,
    sortDirection,
    handleSort,
  } = useListState<BaseCollectionEntity>({
    namespace: org,
    resource: `${connectionId}-${collectionName}`,
    defaultSortKey: "updated_at",
  });

  const items = useCollectionList<BaseCollectionEntity>(
    connectionId,
    collectionName,
    client,
    {
      searchTerm,
      sortKey,
      sortDirection,
    },
  );

  // Collection is read-only if ALL mutation tools are missing
  const isReadOnly = !hasCreateTool && !hasUpdateTool && !hasDeleteTool;

  // Create action handlers
  const handleEdit = (item: BaseCollectionEntity) => {
    if (onItemClick) {
      onItemClick(item);
      return;
    }
    navigate({
      to: "/$org/settings/connections/$appSlug/$collectionName/$itemId",
      params: {
        org,
        appSlug,
        collectionName,
        itemId: item.id,
      },
    });
  };

  const handleDuplicate = async (item: BaseCollectionEntity) => {
    const now = new Date().toISOString();
    await actions.create.mutateAsync({
      ...item,
      id: generatePrefixedId("conn"),
      title: `${item.title} (Copy)`,
      created_at: now,
      updated_at: now,
      created_by: userId,
      updated_by: userId,
    });
  };

  const [itemToDelete, setItemToDelete] = useState<BaseCollectionEntity | null>(
    null,
  );

  const handleDelete = (item: BaseCollectionEntity) => {
    setItemToDelete(item);
  };

  // Build actions object with only available actions
  const listItemActions: Record<string, (item: BaseCollectionEntity) => void> =
    {
      ...(hasUpdateTool && { edit: handleEdit }),
      ...(hasCreateTool && { duplicate: handleDuplicate }),
      ...(hasDeleteTool && { delete: handleDelete }),
    };

  const confirmDelete = async () => {
    if (!itemToDelete) return;
    await actions.delete.mutateAsync(itemToDelete.id);
    setItemToDelete(null);
  };

  const handleCreate = async () => {
    if (!hasCreateTool) {
      toast.error("Create operation is not available for this collection");
      return;
    }

    const now = new Date().toISOString();
    const newItem: BaseCollectionEntity = {
      id: generatePrefixedId("conn"),
      title: "New Item",
      description: "A brief description of the item",
      created_at: now,
      updated_at: now,
      created_by: userId,
      updated_by: userId,
    };

    try {
      const createdItem = await actions.create.mutateAsync(newItem);

      // Navigate to the new item's detail page
      navigate({
        to: "/$org/settings/connections/$appSlug/$collectionName/$itemId",
        params: {
          org,
          appSlug,
          collectionName,
          itemId: createdItem.id,
        },
      });
    } catch (error) {
      // Error toast is handled by the mutation's onError
      console.error("Failed to create item:", error);
    }
  };

  // Generate sort options from schema
  const sortOptions = generateSortOptionsFromSchema(schema);

  const hasItems = (items?.length ?? 0) > 0;
  const showCreateInEmptyState = hasCreateTool && !hasItems && !search;

  const createButton = hasCreateTool ? (
    <Button
      onClick={handleCreate}
      size="sm"
      disabled={actions.create.isPending}
      className="h-7"
    >
      <Plus className="mr-2 h-4 w-4" />
      {actions.create.isPending ? "Creating..." : "Create"}
    </Button>
  ) : null;

  return (
    <>
      <ViewActions>
        <CollectionDisplayButton
          sortKey={sortKey as string}
          sortDirection={sortDirection}
          onSort={handleSort}
          sortOptions={sortOptions}
        />
      </ViewActions>

      <div className="flex flex-col h-full overflow-hidden">
        {/* Search + Create */}
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <CollectionSearch
              value={search}
              onChange={setSearch}
              placeholder={`Search ${collectionName}...`}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearch("");
                  (event.target as HTMLInputElement).blur();
                }
              }}
            />
          </div>
          {hasCreateTool && <div className="pr-3">{createButton}</div>}
        </div>

        {/* Collections List with schema-based rendering */}
        <div className="flex-1 overflow-auto">
          <CollectionsList
            hideToolbar
            data={items ?? []}
            schema={schema}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            search={search}
            onSearchChange={setSearch}
            sortKey={sortKey as string}
            sortDirection={sortDirection}
            onSort={handleSort}
            actions={listItemActions}
            onItemClick={(item) => handleEdit(item)}
            readOnly={isReadOnly}
            emptyState={
              <EmptyState
                image={null}
                title={search ? "No items found" : "No items found"}
                description={
                  search
                    ? "Try adjusting your search terms"
                    : "This collection doesn't have any items yet."
                }
                actions={showCreateInEmptyState ? createButton : undefined}
              />
            }
          />
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!itemToDelete}
        onOpenChange={(open) => {
          if (!open) {
            setItemToDelete(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete item?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{itemToDelete?.title}"? This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actions.delete.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={actions.delete.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {actions.delete.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

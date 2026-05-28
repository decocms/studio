import { useState } from "react";
import { useProjectContext, useVirtualMCPActions } from "@decocms/mesh-sdk";
import { useSpaces } from "@/web/hooks/use-spaces";
import { Page } from "@/web/components/page";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { ProjectCard } from "@/web/components/project-card";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { useCreateVirtualMCP } from "@/web/hooks/use-create-virtual-mcp";
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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { FolderClosed, Plus } from "@untitledui/icons";
import { toast } from "sonner";

export default function SpacesListPage() {
  const { org } = useProjectContext();
  const spaces = useSpaces();
  const actions = useVirtualMCPActions();
  const [search, setSearch] = useState("");
  const { createVirtualMCP, isCreating } = useCreateVirtualMCP({
    navigateOnCreate: true,
  });
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  // Filter out org-admin and apply search
  const filteredSpaces = spaces.filter(
    (s) =>
      s.id !== org.id &&
      (s.title.toLowerCase().includes(search.toLowerCase()) ||
        s.description?.toLowerCase().includes(search.toLowerCase())),
  );

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { id, title } = deleteTarget;
    setDeleteTarget(null);
    try {
      await actions.delete.mutateAsync(id);
      toast.success(`Deleted "${title}"`);
    } catch {
      // Error toast handled by mutation
    }
  };

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Spaces</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
        <Page.Header.Right>
          <Button
            onClick={() => createVirtualMCP()}
            disabled={isCreating}
            size="sm"
          >
            <Plus size={14} />
            Create Space
          </Button>
        </Page.Header.Right>
      </Page.Header>

      <CollectionSearch
        value={search}
        onChange={setSearch}
        placeholder="Search for a space..."
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setSearch("");
            (event.target as HTMLInputElement).blur();
          }
        }}
      />

      <Page.Content className="@container">
        {filteredSpaces.length === 0 && (
          <div className="flex items-center h-full">
            <EmptyState
              image={
                <FolderClosed size={48} className="text-muted-foreground" />
              }
              title={search ? "No spaces found" : "No spaces yet"}
              description={
                search
                  ? `No spaces match "${search}"`
                  : "Create a space to get started."
              }
              actions={
                !search && (
                  <Button
                    size="sm"
                    onClick={() => createVirtualMCP()}
                    disabled={isCreating}
                  >
                    <Plus size={14} />
                    Create Space
                  </Button>
                )
              }
            />
          </div>
        )}

        {filteredSpaces.length > 0 && (
          <div className="p-5">
            <div className="grid grid-cols-1 @lg:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-4 gap-4">
              {filteredSpaces.map((space) => (
                <ProjectCard
                  key={space.id}
                  project={space}
                  onDeleteClick={() =>
                    setDeleteTarget({
                      id: space.id,
                      title: space.title,
                    })
                  }
                />
              ))}
            </div>
          </div>
        )}
      </Page.Content>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Space?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete{" "}
              <span className="font-medium text-foreground">
                {deleteTarget?.title}
              </span>
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

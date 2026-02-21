import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usePluginContext } from "@decocms/mesh-sdk/plugins";
import { DECO_BLOCKS_BINDING } from "@decocms/bindings";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  createPage,
  deletePage,
  listPages,
  updatePage,
  type GenericToolCaller,
  type Page,
} from "../lib/page-api";
import { QUERY_KEYS } from "../lib/query-keys";
import { PageModal } from "./page-modal";

export default function PagesList() {
  const { toolCaller, connection } =
    usePluginContext<typeof DECO_BLOCKS_BINDING>();
  const genericCaller = toolCaller as unknown as GenericToolCaller;
  const { org, project } = useParams({ strict: false }) as {
    org: string;
    project: string;
  };
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Page | null>(null);

  const projectId = connection?.id ?? "";

  const { data: pages = [], isLoading } = useQuery({
    queryKey: QUERY_KEYS.pages(projectId),
    queryFn: () => listPages(genericCaller),
    enabled: !!toolCaller,
  });

  const createMutation = useMutation({
    mutationFn: ({ title, path }: { title: string; path: string }) =>
      createPage(genericCaller, title, path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.pages(projectId) });
      toast.success("Page created");
    },
    onError: () => toast.error("Failed to create page"),
  });

  const renameMutation = useMutation({
    mutationFn: ({ page, title }: { page: Page; title: string }) =>
      updatePage(genericCaller, { ...page, title }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.pages(projectId) });
      toast.success("Page renamed");
    },
    onError: () => toast.error("Failed to rename page"),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ page }: { page: Page }) =>
      deletePage(genericCaller, page.id, page.title),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.pages(projectId) });
      toast.success("Page deleted");
    },
    onError: () => toast.error("Failed to delete page"),
  });

  const handlePageClick = (page: Page) => {
    navigate({
      to: "/$org/$project/$pluginId/pages/$pageId",
      params: {
        org,
        project,
        pluginId: "site-editor",
        pageId: page.id,
      },
    });
  };

  const handleDelete = (page: Page) => {
    if (!confirm(`Delete "${page.title}"? This cannot be undone.`)) return;
    deleteMutation.mutate({ page });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-sm text-muted-foreground">Loading pages...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <h2 className="text-sm font-medium">Pages</h2>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus size={14} className="mr-1" />
          New page
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {pages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-sm text-muted-foreground">
            <p>No pages yet.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreateOpen(true)}
            >
              Create your first page
            </Button>
          </div>
        ) : (
          <ul className="divide-y">
            {pages.map((page) => (
              <li
                key={page.id}
                className="flex items-center px-4 py-2.5 hover:bg-accent/40 group"
              >
                <button
                  className="flex-1 text-left text-sm"
                  onClick={() => handlePageClick(page)}
                >
                  <div className="font-medium">{page.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {page.path}
                  </div>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="opacity-0 group-hover:opacity-100 h-7 w-7"
                    >
                      <MoreHorizontal size={14} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setRenameTarget(page)}>
                      <Pencil size={14} className="mr-2" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => handleDelete(page)}
                    >
                      <Trash2 size={14} className="mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </div>

      <PageModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (title, path) => {
          await createMutation.mutateAsync({ title, path });
        }}
        mode="create"
      />

      {renameTarget && (
        <PageModal
          open={true}
          onClose={() => setRenameTarget(null)}
          onSubmit={async (title) => {
            await renameMutation.mutateAsync({ page: renameTarget, title });
          }}
          mode="rename"
          initialTitle={renameTarget.title}
        />
      )}
    </div>
  );
}

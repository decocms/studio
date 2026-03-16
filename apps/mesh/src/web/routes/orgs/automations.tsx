/**
 * Automations List Page
 *
 * Displays all automations for the current organization with their status
 * and trigger counts. Allows creating new automations and navigating to details.
 */

import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { Page } from "@/web/components/page";
import {
  useAutomationsList,
  useAutomationCreate,
  useAutomationDelete,
} from "@/web/hooks/use-automations";
import { useListState } from "@/web/hooks/use-list-state";
import { User } from "@/web/components/user/user.tsx";
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
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Table as UITable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ORG_ADMIN_PROJECT_SLUG, useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  DotsVertical,
  Eye,
  Loading01,
  Plus,
  Trash01,
} from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";

export default function AutomationsPage() {
  const navigate = useNavigate();
  const { org, locator } = useProjectContext();
  const { data: automations, isLoading } = useAutomationsList();
  const createMutation = useAutomationCreate();
  const deleteMutation = useAutomationDelete();
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const listState = useListState({
    namespace: org.slug,
    resource: "automations",
    defaultViewMode: "table",
  });

  const orgSlug = locator.split("/")[0] ?? org.slug ?? ORG_ADMIN_PROJECT_SLUG;

  const handleCreate = async () => {
    try {
      const result = await createMutation.mutateAsync({
        name: "New Automation",
        agent: { id: "" },
        messages: [],
        models: {
          credentialId: "",
          thinking: { id: "" },
        },
        temperature: 0.5,
        active: true,
      });
      navigate({
        to: "/$org/$project/automations/$automationId",
        params: {
          org: orgSlug,
          project: ORG_ADMIN_PROJECT_SLUG,
          automationId: result.id,
        },
      });
    } catch (err) {
      toast.error("Failed to create automation");
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      toast.success("Automation deleted");
    } catch {
      toast.error("Failed to delete automation");
    } finally {
      setDeleteTarget(null);
    }
  };

  const navigateToAutomation = (automationId: string) => {
    navigate({
      to: "/$org/$project/automations/$automationId",
      params: {
        org: orgSlug,
        project: ORG_ADMIN_PROJECT_SLUG,
        automationId,
      },
    });
  };

  const filteredAutomations = (automations ?? [])
    .filter((a) => {
      if (!listState.searchTerm) return true;
      return a.name.toLowerCase().includes(listState.searchTerm.toLowerCase());
    })
    .sort((a, b) => {
      if (!listState.sortDirection) return 0;
      const dir = listState.sortDirection === "asc" ? 1 : -1;
      const key = listState.sortKey as string;
      if (key === "name") return a.name.localeCompare(b.name) * dir;
      if (key === "active")
        return ((a.active ? 1 : 0) - (b.active ? 1 : 0)) * dir;
      if (key === "trigger_count")
        return ((a.trigger_count ?? 0) - (b.trigger_count ?? 0)) * dir;
      return 0;
    });

  const headerCell =
    "px-4 py-2 text-left font-mono font-normal text-muted-foreground text-[11px] h-9 uppercase tracking-wider group transition-colors select-none";

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage className="flex items-center gap-2">
                  Automations
                  {automations && automations.length > 0 && (
                    <span className="text-xs font-normal text-muted-foreground tabular-nums">
                      {automations.length} total
                    </span>
                  )}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
        <Page.Header.Right>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? (
              <Loading01 size={14} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
            Create Automation
          </Button>
        </Page.Header.Right>
      </Page.Header>

      {/* Search Bar — flush, full width */}
      <CollectionSearch
        value={listState.search}
        onChange={listState.setSearch}
        placeholder="Search automations..."
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            listState.setSearch("");
            (event.target as HTMLInputElement).blur();
          }
        }}
      />

      <Page.Content>
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loading01
              size={24}
              className="animate-spin text-muted-foreground"
            />
          </div>
        ) : !automations || automations.length === 0 ? (
          <div className="flex items-center h-full">
            <EmptyState
              title="No automations yet"
              description="Automations run tasks on a schedule or in response to events."
              actions={
                <Button
                  size="sm"
                  onClick={handleCreate}
                  disabled={createMutation.isPending}
                >
                  {createMutation.isPending ? (
                    <Loading01 size={14} className="animate-spin" />
                  ) : (
                    <Plus size={14} />
                  )}
                  Create Automation
                </Button>
              }
            />
          </div>
        ) : (
          <UITable className="w-full border-collapse">
            <TableHeader className="border-b-0">
              <TableRow className="h-9 hover:bg-transparent border-b border-border">
                {(
                  [
                    {
                      id: "name",
                      label: "Name",
                      className:
                        "flex-1 min-w-0 cursor-pointer hover:bg-accent",
                    },
                    {
                      id: "active",
                      label: "Status",
                      className: "w-24 shrink-0 cursor-pointer hover:bg-accent",
                    },
                    {
                      id: "trigger_count",
                      label: "Triggers",
                      className: "w-24 shrink-0 cursor-pointer hover:bg-accent",
                    },
                    {
                      id: "created_by",
                      label: "Created by",
                      className: "w-40 shrink-0",
                    },
                    { id: "_actions", label: "", className: "w-12 shrink-0" },
                  ] as const
                ).map(({ id, label, className }) => {
                  const isActive = listState.sortKey === id;
                  const sortable = id !== "created_by" && id !== "_actions";
                  return (
                    <TableHead
                      key={id}
                      className={cn(headerCell, className)}
                      onClick={
                        sortable ? () => listState.handleSort(id) : undefined
                      }
                    >
                      <span className="flex items-center gap-1">
                        {label}
                        {sortable && (
                          <span className="w-4 flex items-center justify-center">
                            {isActive && listState.sortDirection === "asc" && (
                              <ArrowUp
                                size={12}
                                className="text-muted-foreground"
                              />
                            )}
                            {isActive && listState.sortDirection === "desc" && (
                              <ArrowDown
                                size={12}
                                className="text-muted-foreground"
                              />
                            )}
                          </span>
                        )}
                      </span>
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAutomations.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-16 text-center">
                    <span className="text-sm text-muted-foreground">
                      No automations match &quot;{listState.search}&quot;
                    </span>
                  </td>
                </tr>
              ) : (
                filteredAutomations.map((automation) => (
                  <TableRow
                    key={automation.id}
                    className="group/data-row border-b-0 hover:bg-accent/50 cursor-pointer transition-colors"
                    onClick={() => navigateToAutomation(automation.id)}
                  >
                    <TableCell className="px-5 py-4 h-16 align-middle text-sm font-medium text-foreground flex-1 min-w-0">
                      {automation.name}
                    </TableCell>
                    <TableCell className="px-5 py-4 h-16 align-middle w-24 shrink-0">
                      <Badge
                        variant={automation.active ? "default" : "secondary"}
                      >
                        {automation.active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-5 py-4 h-16 align-middle text-sm text-muted-foreground w-24 shrink-0">
                      {automation.trigger_count}
                    </TableCell>
                    <TableCell className="px-5 py-4 h-16 align-middle w-40 shrink-0">
                      <User id={automation.created_by} />
                    </TableCell>
                    <TableCell className="px-5 py-4 h-16 align-middle w-12 shrink-0">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <DotsVertical size={20} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              navigateToAutomation(automation.id);
                            }}
                          >
                            <Eye size={16} />
                            Open
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget({
                                id: automation.id,
                                name: automation.name,
                              });
                            }}
                          >
                            <Trash01 size={16} />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </UITable>
        )}

        {/* Delete confirmation dialog */}
        <AlertDialog
          open={!!deleteTarget}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Automation?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. This will permanently delete{" "}
                <span className="font-medium text-foreground">
                  {deleteTarget?.name}
                </span>
                . All triggers will be removed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Page.Content>
    </Page>
  );
}

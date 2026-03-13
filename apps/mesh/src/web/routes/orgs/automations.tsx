/**
 * Automations List Page
 *
 * Displays all automations for the current organization with their status
 * and trigger counts. Allows creating new automations and navigating to details.
 */

import { EmptyState } from "@/web/components/empty-state.tsx";
import { Page } from "@/web/components/page";
import {
  useAutomationsList,
  useAutomationCreate,
  useAutomationDelete,
} from "@/web/hooks/use-automations";
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
  Table as UITable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";
import { ORG_ADMIN_PROJECT_SLUG, useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { Loading01, Plus, Trash01 } from "@untitledui/icons";
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

  const orgSlug = locator.split("/")[0] ?? org.slug ?? ORG_ADMIN_PROJECT_SLUG;

  const handleCreate = async () => {
    try {
      const result = await createMutation.mutateAsync({
        name: "New Automation",
        agent: { id: "", mode: "passthrough" },
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

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Automations</BreadcrumbPage>
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
          <div className="p-4">
            <UITable>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Triggers</TableHead>
                  <TableHead>Created by</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {automations.map((automation) => (
                  <TableRow
                    key={automation.id}
                    className="cursor-pointer"
                    onClick={() =>
                      navigate({
                        to: "/$org/$project/automations/$automationId",
                        params: {
                          org: orgSlug,
                          project: ORG_ADMIN_PROJECT_SLUG,
                          automationId: automation.id,
                        },
                      })
                    }
                  >
                    <TableCell className="font-medium">
                      {automation.name}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={automation.active ? "default" : "secondary"}
                      >
                        {automation.active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {automation.trigger_count}
                    </TableCell>
                    <TableCell>
                      <User id={automation.created_by} />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget({
                            id: automation.id,
                            name: automation.name,
                          });
                        }}
                      >
                        <Trash01 size={14} className="text-muted-foreground" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </UITable>
          </div>
        )}

        {/* Delete confirmation dialog */}
        <AlertDialog
          open={!!deleteTarget}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Automation</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete &quot;{deleteTarget?.name}
                &quot;? This action cannot be undone. All triggers will be
                removed.
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

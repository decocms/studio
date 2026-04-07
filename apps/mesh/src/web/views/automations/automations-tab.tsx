/**
 * Automations tab content for project settings.
 * Shows automations pre-filtered to the current project's agent.
 */

import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  useAutomationsList,
  useAutomationCreate,
  useAutomationDelete,
  useAutomationDetail,
  buildDefaultAutomationInput,
} from "@/web/hooks/use-automations";
import { SettingsTab } from "./automation-detail.tsx";
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
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  DotsVertical,
  Eye,
  Loading01,
  Plus,
  RefreshCcw01,
  Trash01,
} from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { toast } from "sonner";

// ============================================================================
// Inline Detail Wrapper
// ============================================================================

export function AutomationInlineDetail({
  automationId,
  onBack,
}: {
  automationId: string;
  onBack?: () => void;
}) {
  const { data: automation, isLoading } = useAutomationDetail(automationId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loading01 size={24} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!automation) {
    return (
      <EmptyState
        title="Automation not found"
        description="This automation may have been deleted."
      />
    );
  }

  return (
    <div className="flex flex-col h-full w-full overflow-auto">
      <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-6 md:px-10 md:pt-8 md:pb-10">
        <SettingsTab
          key={automationId}
          automationId={automationId}
          automation={automation}
          onBack={onBack}
        />
      </div>
    </div>
  );
}

// ============================================================================
// Main Export: List + Detail
// ============================================================================

export function AutomationsTabContent({
  virtualMcpId,
  selectedAutomationId,
}: {
  virtualMcpId: string;
  selectedAutomationId?: string;
}) {
  const { data: allAutomations, isLoading } = useAutomationsList(virtualMcpId);
  const createMutation = useAutomationCreate();
  const deleteMutation = useAutomationDelete();
  const navigate = useNavigate();
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const automations = allAutomations ?? [];

  const selectAutomation = (id: string | undefined) => {
    navigate({
      search: { id } as never,
      replace: true,
    });
  };

  const handleCreate = async () => {
    try {
      const result = await createMutation.mutateAsync(
        buildDefaultAutomationInput(virtualMcpId),
      );
      selectAutomation(result.id);
    } catch {
      toast.error("Failed to create automation");
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      if (selectedAutomationId === deleteTarget.id) {
        selectAutomation(undefined);
      }
      toast.success("Automation deleted");
    } catch {
      toast.error("Failed to delete automation");
    } finally {
      setDeleteTarget(null);
    }
  };

  // Detail view
  if (selectedAutomationId) {
    return (
      <ErrorBoundary fallback={() => null}>
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-64">
              <Loading01
                size={24}
                className="animate-spin text-muted-foreground"
              />
            </div>
          }
        >
          <AutomationInlineDetail
            automationId={selectedAutomationId}
            onBack={() => selectAutomation(undefined)}
          />
        </Suspense>
      </ErrorBoundary>
    );
  }

  // List view
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loading01 size={24} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (automations.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <EmptyState
          image={<RefreshCcw01 size={48} className="text-muted-foreground" />}
          title="No automations"
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
    );
  }

  return (
    <div className="flex flex-col">
      {/* Create button at top of non-empty list */}
      <div className="flex items-center justify-end px-6 py-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={handleCreate}
          disabled={createMutation.isPending}
        >
          {createMutation.isPending ? (
            <Loading01 size={13} className="animate-spin" />
          ) : (
            <Plus size={13} />
          )}
          Create
        </Button>
      </div>

      {automations.map((automation) => (
        <button
          key={automation.id}
          type="button"
          className="flex items-center gap-3 px-6 py-3 text-left hover:bg-accent/50 transition-colors cursor-pointer border-b border-border"
          onClick={() => selectAutomation(automation.id)}
        >
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium truncate block">
              {automation.name}
            </span>
          </div>
          <Badge variant={automation.active ? "default" : "secondary"}>
            {automation.active ? "Active" : "Inactive"}
          </Badge>
          <span className="text-xs text-muted-foreground shrink-0">
            {automation.trigger_count} trigger
            {automation.trigger_count !== 1 ? "s" : ""}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <DotsVertical size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  selectAutomation(automation.id);
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
        </button>
      ))}

      {/* Delete confirmation */}
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
    </div>
  );
}

import { CollectionDisplayButton } from "@/web/components/collections/collection-display-button.tsx";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { CollectionTableWrapper } from "@/web/components/collections/collection-table-wrapper.tsx";
import { ConnectionCard } from "@/web/components/connections/connection-card.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { Page } from "@/web/components/page";
import type { TriggerEntity } from "@/web/components/triggers/trigger-form";
import { useListState } from "@/web/hooks/use-list-state";
import { KEYS } from "@/web/lib/query-keys";
import { formatTimeAgo } from "@/web/lib/format-time";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import type { TableColumn } from "@/web/components/collections/collection-table.tsx";
import {
  SELF_MCP_ALIAS_ID,
  ORG_ADMIN_PROJECT_SLUG,
  useProjectContext,
  useMCPClient,
} from "@decocms/mesh-sdk";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Clock,
  DotsVertical,
  Eye,
  Lightning01,
  Loading01,
  Plus,
  Trash01,
} from "@untitledui/icons";
import { Suspense, useReducer } from "react";
import { Cron } from "croner";
import { toast } from "sonner";

// ---- Helpers ----

function cronToHuman(expr: string): string {
  try {
    const parts = expr.split(" ");
    if (parts.length < 5) return expr;

    const min = parts[0] ?? "*";
    const hour = parts[1] ?? "*";
    const dayOfMonth = parts[2] ?? "*";
    const month = parts[3] ?? "*";
    const dayOfWeek = parts[4] ?? "*";

    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const monthNames = [
      "",
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];

    if (
      min === "*" &&
      hour === "*" &&
      dayOfMonth === "*" &&
      month === "*" &&
      dayOfWeek === "*"
    ) {
      return "Every minute";
    }
    if (min?.startsWith("*/") && hour === "*") {
      return `Every ${min.slice(2)} minutes`;
    }
    if (min !== "*" && hour === "*" && dayOfMonth === "*") {
      return `Every hour at :${min?.padStart(2, "0")}`;
    }
    if (hour?.startsWith("*/")) {
      return `Every ${hour.slice(2)} hours`;
    }

    const timeStr =
      hour !== "*" && min !== "*"
        ? `${hour?.padStart(2, "0")}:${min?.padStart(2, "0")}`
        : null;

    if (dayOfWeek === "1-5" && timeStr) return `Weekdays at ${timeStr}`;
    if (dayOfWeek !== "*" && timeStr) {
      const days = dayOfWeek.split(",").map((d) => dayNames[Number(d)] ?? d);
      return `${days.join(", ")} at ${timeStr}`;
    }
    if (dayOfMonth !== "*" && month === "*" && timeStr) {
      return `Day ${dayOfMonth} of every month at ${timeStr}`;
    }
    if (dayOfMonth !== "*" && month !== "*" && timeStr) {
      return `${monthNames[Number(month)] ?? month} ${dayOfMonth} at ${timeStr}`;
    }
    if (timeStr && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      return `Daily at ${timeStr}`;
    }
    return expr;
  } catch {
    return expr;
  }
}

function getNextRun(expr: string): string | null {
  try {
    const cron = new Cron(expr);
    const next = cron.nextRun();
    if (!next) return null;
    const now = new Date();
    const diff = next.getTime() - now.getTime();
    if (diff < 60000) return "in < 1 min";
    if (diff < 3600000) return `in ${Math.round(diff / 60000)} min`;
    if (diff < 86400000) return `in ${Math.round(diff / 3600000)}h`;
    return next.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

function triggerDescription(trigger: TriggerEntity): string {
  if (trigger.triggerType === "cron" && trigger.cronExpression) {
    return cronToHuman(trigger.cronExpression);
  }
  if (trigger.eventType) {
    return `On "${trigger.eventType}" event`;
  }
  return "Not configured";
}

function actionDescription(trigger: TriggerEntity): string {
  if (trigger.actionType === "tool_call") {
    return trigger.toolName ?? "Call a tool";
  }
  return "Run an agent";
}

// ---- Dialog state ----

type DialogState =
  | { mode: "idle" }
  | { mode: "deleting"; trigger: TriggerEntity };

type DialogAction =
  | { type: "delete"; trigger: TriggerEntity }
  | { type: "close" };

function dialogReducer(_state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "delete":
      return { mode: "deleting", trigger: action.trigger };
    case "close":
      return { mode: "idle" };
  }
}

// ---- Main content ----

function TriggersContent() {
  const { org, locator } = useProjectContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const listState = useListState({
    namespace: org.slug,
    resource: "triggers",
  });

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data } = useSuspenseQuery({
    queryKey: KEYS.triggers(locator),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "TRIGGER_LIST",
        arguments: {},
      })) as { structuredContent?: { triggers: TriggerEntity[] } };
      return (
        (result.structuredContent as { triggers: TriggerEntity[] }) ?? {
          triggers: [],
        }
      );
    },
  });

  const allTriggers = data?.triggers ?? [];

  // Client-side search filter
  const triggers = listState.searchTerm
    ? allTriggers.filter((t) => {
        const s = listState.searchTerm.toLowerCase();
        return (
          (t.title ?? "").toLowerCase().includes(s) ||
          triggerDescription(t).toLowerCase().includes(s) ||
          actionDescription(t).toLowerCase().includes(s)
        );
      })
    : allTriggers;

  const [dialogState, dispatch] = useReducer(dialogReducer, { mode: "idle" });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      await client.callTool({
        name: "TRIGGER_UPDATE",
        arguments: { id, enabled },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.triggers(locator) });
    },
    onError: (err) => {
      toast.error(`Failed to toggle trigger: ${err.message}`);
      queryClient.invalidateQueries({ queryKey: KEYS.triggers(locator) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await client.callTool({
        name: "TRIGGER_DELETE",
        arguments: { id },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.triggers(locator) });
      toast.success("Trigger deleted");
    },
    onError: (err) => {
      toast.error(`Failed to delete trigger: ${err.message}`);
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const result = await client.callTool({
        name: "TRIGGER_CREATE",
        arguments: {
          triggerType: "cron",
          cronExpression: "0 9 * * *",
          actionType: "tool_call",
        },
      });
      return result;
    },
    onSuccess: (result) => {
      const data = (result as { structuredContent?: TriggerEntity })
        .structuredContent;
      if (data?.id) {
        queryClient.invalidateQueries({ queryKey: KEYS.triggers(locator) });
        navigate({
          to: "/$org/$project/triggers/$triggerId",
          params: {
            org: org.slug,
            project: ORG_ADMIN_PROJECT_SLUG,
            triggerId: data.id,
          },
        });
      }
    },
    onError: (err) => {
      toast.error(`Failed to create trigger: ${err.message}`);
    },
  });

  const confirmDelete = async () => {
    if (dialogState.mode !== "deleting") return;
    const id = dialogState.trigger.id;
    dispatch({ type: "close" });
    try {
      await deleteMutation.mutateAsync(id);
    } catch {
      // Error toast handled by mutation
    }
  };

  const navigateToTrigger = (trigger: TriggerEntity) => {
    navigate({
      to: "/$org/$project/triggers/$triggerId",
      params: {
        org: org.slug,
        project: ORG_ADMIN_PROJECT_SLUG,
        triggerId: trigger.id,
      },
    });
  };

  const columns: TableColumn<TriggerEntity>[] = [
    {
      id: "title",
      header: "Name",
      render: (trigger) => (
        <div className="flex items-center gap-2.5 min-w-0">
          {trigger.triggerType === "cron" ? (
            <Clock size={16} className="shrink-0 text-muted-foreground" />
          ) : (
            <Lightning01 size={16} className="shrink-0 text-muted-foreground" />
          )}
          <span className="text-sm font-medium text-foreground truncate">
            {trigger.title || "Untitled trigger"}
          </span>
        </div>
      ),
      cellClassName: "w-48 min-w-0 shrink-0",
      sortable: true,
    },
    {
      id: "triggerType",
      header: "Schedule",
      render: (trigger) => (
        <span className="text-sm text-foreground truncate">
          {triggerDescription(trigger)}
        </span>
      ),
      cellClassName: "flex-1 min-w-0",
      sortable: true,
    },
    {
      id: "actionType",
      header: "Action",
      render: (trigger) => (
        <span className="text-sm text-muted-foreground truncate">
          {actionDescription(trigger)}
        </span>
      ),
      cellClassName: "w-40 shrink-0",
      sortable: true,
    },
    {
      id: "enabled",
      header: "Enabled",
      render: (trigger) => (
        <div onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={trigger.enabled}
            onCheckedChange={() =>
              toggleMutation.mutate({
                id: trigger.id,
                enabled: !trigger.enabled,
              })
            }
            disabled={toggleMutation.isPending}
          />
        </div>
      ),
      cellClassName: "w-20 shrink-0",
    },
    {
      id: "updatedAt",
      header: "Updated",
      render: (trigger) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {trigger.updatedAt ? formatTimeAgo(new Date(trigger.updatedAt)) : "—"}
        </span>
      ),
      cellClassName: "w-24 shrink-0",
      sortable: true,
    },
    {
      id: "actions",
      header: "",
      render: (trigger) => (
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
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                navigateToTrigger(trigger);
              }}
            >
              <Eye size={16} />
              Open
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ type: "delete", trigger });
              }}
            >
              <Trash01 size={16} />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
      cellClassName: "w-12 shrink-0",
    },
  ];

  const ctaButton = (
    <Button
      onClick={() => createMutation.mutate()}
      size="sm"
      className="h-7 px-3 rounded-lg text-sm font-medium"
      disabled={createMutation.isPending}
    >
      {createMutation.isPending ? (
        <Loading01 size={14} className="animate-spin" />
      ) : (
        <Plus size={16} />
      )}
      {createMutation.isPending ? "Creating..." : "New Trigger"}
    </Button>
  );

  const emptyIcon = <Lightning01 size={36} className="text-muted-foreground" />;

  return (
    <Page>
      {/* Delete Confirmation */}
      <AlertDialog
        open={dialogState.mode === "deleting"}
        onOpenChange={(open) => !open && dispatch({ type: "close" })}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Trigger?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete{" "}
              <span className="font-medium text-foreground">
                {dialogState.mode === "deleting" &&
                  (dialogState.trigger.title || "Untitled trigger")}
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

      {/* Header */}
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Triggers</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
        <Page.Header.Right>
          <CollectionDisplayButton
            viewMode={listState.viewMode}
            onViewModeChange={listState.setViewMode}
            sortKey={listState.sortKey}
            sortDirection={listState.sortDirection}
            onSort={listState.handleSort}
            sortOptions={[
              { id: "title", label: "Name" },
              { id: "triggerType", label: "Schedule" },
              { id: "updatedAt", label: "Updated" },
            ]}
          />
          {ctaButton}
        </Page.Header.Right>
      </Page.Header>

      {/* Search */}
      <CollectionSearch
        value={listState.search}
        onChange={listState.setSearch}
        placeholder="Search for a trigger..."
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            listState.setSearch("");
            (event.target as HTMLInputElement).blur();
          }
        }}
      />

      {/* Content */}
      <Page.Content>
        {listState.viewMode === "cards" ? (
          <div className="flex-1 overflow-auto p-5">
            {triggers.length === 0 ? (
              <EmptyState
                image={emptyIcon}
                title={
                  listState.search ? "No triggers found" : "No triggers yet"
                }
                description={
                  listState.search
                    ? `No triggers match "${listState.search}"`
                    : "Create your first automation — schedule recurring actions or react to events."
                }
              />
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
                {triggers.map((trigger) => (
                  <ConnectionCard
                    key={trigger.id}
                    connection={{
                      id: trigger.id,
                      title: trigger.title || "Untitled trigger",
                      description: triggerDescription(trigger),
                      icon: null,
                    }}
                    fallbackIcon={
                      trigger.triggerType === "cron" ? (
                        <Clock size={20} />
                      ) : (
                        <Lightning01 size={20} />
                      )
                    }
                    onClick={() => navigateToTrigger(trigger)}
                    footer={
                      <div className="flex items-center justify-between w-full">
                        <span className="text-xs text-muted-foreground truncate">
                          {actionDescription(trigger)}
                          {trigger.triggerType === "cron" &&
                            trigger.cronExpression &&
                            (() => {
                              const next = getNextRun(trigger.cronExpression);
                              return next ? ` · Next: ${next}` : "";
                            })()}
                        </span>
                        <div onClick={(e) => e.stopPropagation()}>
                          <Switch
                            checked={trigger.enabled}
                            onCheckedChange={() =>
                              toggleMutation.mutate({
                                id: trigger.id,
                                enabled: !trigger.enabled,
                              })
                            }
                            disabled={toggleMutation.isPending}
                          />
                        </div>
                      </div>
                    }
                    headerActions={
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
                              navigateToTrigger(trigger);
                            }}
                          >
                            <Eye size={16} />
                            Open
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              dispatch({ type: "delete", trigger });
                            }}
                          >
                            <Trash01 size={16} />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    }
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="h-full flex flex-col overflow-hidden">
            <CollectionTableWrapper
              columns={columns}
              data={triggers}
              isLoading={false}
              sortKey={listState.sortKey}
              sortDirection={listState.sortDirection}
              onSort={listState.handleSort}
              onRowClick={navigateToTrigger}
              emptyState={
                listState.search ? (
                  <EmptyState
                    image={emptyIcon}
                    title="No triggers found"
                    description={`No triggers match "${listState.search}"`}
                  />
                ) : (
                  <EmptyState
                    image={emptyIcon}
                    title="No triggers yet"
                    description="Create your first automation — schedule recurring actions or react to events."
                  />
                )
              }
            />
          </div>
        )}
      </Page.Content>
    </Page>
  );
}

export default function OrgTriggers() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <TriggersContent />
      </Suspense>
    </ErrorBoundary>
  );
}

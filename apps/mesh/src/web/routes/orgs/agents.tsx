import { CollectionDisplayButton } from "@/web/components/collections/collection-display-button.tsx";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { Page } from "@/web/components/page";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { ConnectionCard } from "@/web/components/connections/connection-card.tsx";
import { ConnectionStatus } from "@/web/components/connections/connection-status.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { AgentAvatar } from "@/web/components/agent-icon";
import { useListState } from "@/web/hooks/use-list-state";
import { useCreateVirtualMCP } from "@/web/hooks/use-create-virtual-mcp";
import {
  isDecopilot,
  useProjectContext,
  useVirtualMCPs,
  useVirtualMCPActions,
  type VirtualMCPEntity,
} from "@decocms/mesh-sdk";
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
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@deco/ui/components/sheet.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { type TableColumn } from "@/web/components/collections/collection-table.tsx";
import {
  Table as UITable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  ArrowDown,
  ArrowUp,
  CheckSquare,
  ChevronDown,
  DotsVertical,
  Eye,
  Loading01,
  Plus,
  Trash01,
  Users03,
  XClose,
} from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, Suspense, useReducer, useState } from "react";
import { User } from "@/web/components/user/user.tsx";
import { AgentConnectionsPreview } from "@/web/components/connections/agent-connections-preview.tsx";
import { formatTimeAgo } from "@/web/lib/format-time";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

interface AgentGroup {
  type: "group";
  key: string;
  icon: string | null;
  title: string;
  agents: VirtualMCPEntity[];
}

interface SingleAgent {
  type: "single";
  agent: VirtualMCPEntity;
}

type GroupedItem = SingleAgent | AgentGroup;

function getGroupKey(a: VirtualMCPEntity): string {
  return a.title.trim().replace(/\s+\(\d+\)$/, "");
}

function groupAgents(agents: VirtualMCPEntity[]): GroupedItem[] {
  const buckets = new Map<string, VirtualMCPEntity[]>();
  for (const a of agents) {
    const key = getGroupKey(a);
    const list = buckets.get(key);
    if (list) {
      list.push(a);
    } else {
      buckets.set(key, [a]);
    }
  }

  const items: GroupedItem[] = [];
  const seen = new Set<string>();

  for (const a of agents) {
    const key = getGroupKey(a);
    if (seen.has(key)) continue;
    seen.add(key);

    const bucket = buckets.get(key)!;
    const first = bucket[0]!;
    if (bucket.length === 1) {
      items.push({ type: "single", agent: first });
    } else {
      items.push({
        type: "group",
        key,
        icon: first.icon,
        title: first.title.replace(/\s*\(\d+\)\s*$/, ""),
        agents: bucket,
      });
    }
  }
  return items;
}

function getUniqueCreators(agents: VirtualMCPEntity[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const a of agents) {
    if (a.created_by && !seen.has(a.created_by)) {
      seen.add(a.created_by);
      result.push(a.created_by);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Dialog state
// ---------------------------------------------------------------------------

type DialogState =
  | { mode: "idle" }
  | { mode: "deleting"; virtualMcp: VirtualMCPEntity };

type DialogAction =
  | { type: "delete"; virtualMcp: VirtualMCPEntity }
  | { type: "close" };

function dialogReducer(_state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "delete":
      return { mode: "deleting", virtualMcp: action.virtualMcp };
    case "close":
      return { mode: "idle" };
  }
}

// ---------------------------------------------------------------------------
// Agent group card (cards view — same size as ConnectionCard, opens dialog)
// ---------------------------------------------------------------------------

function AgentGroupCard({
  group,
  onNavigate,
  onDelete,
  selectionMode,
  selectedIds,
  onToggleSelect,
}: {
  group: AgentGroup;
  onNavigate: (id: string) => void;
  onDelete: (agent: VirtualMCPEntity) => void;
  selectionMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const isMobile = useIsMobile();
  const allSelected = group.agents.every((a) => selectedIds.has(a.id));
  const someSelected = group.agents.some((a) => selectedIds.has(a.id));
  const creators = getUniqueCreators(group.agents);

  const mostRecent = group.agents.reduce((latest, a) => {
    const t = a.updated_at ?? a.created_at;
    const l = latest.updated_at ?? latest.created_at;
    if (!t) return latest;
    if (!l) return a;
    return new Date(t) > new Date(l) ? a : latest;
  }, group.agents[0]!);
  const recentTs = mostRecent.updated_at ?? mostRecent.created_at;

  return (
    <>
      <ConnectionCard
        connection={{
          title: group.title,
          icon: group.icon,
          description: `${group.agents.length} instances`,
        }}
        onClick={() =>
          selectionMode
            ? (() => {
                for (const a of group.agents) {
                  if (allSelected) {
                    if (selectedIds.has(a.id)) onToggleSelect(a.id);
                  } else {
                    if (!selectedIds.has(a.id)) onToggleSelect(a.id);
                  }
                }
              })()
            : setDialogOpen(true)
        }
        className={cn(
          selectionMode && allSelected && "ring-2 ring-primary",
          selectionMode &&
            someSelected &&
            !allSelected &&
            "ring-1 ring-primary/50",
        )}
        fallbackIcon={<Users03 />}
        headerActions={
          selectionMode ? (
            <Checkbox
              checked={
                allSelected ? true : someSelected ? "indeterminate" : false
              }
              onCheckedChange={() => {
                for (const a of group.agents) {
                  if (allSelected) {
                    if (selectedIds.has(a.id)) onToggleSelect(a.id);
                  } else {
                    if (!selectedIds.has(a.id)) onToggleSelect(a.id);
                  }
                }
              }}
            />
          ) : (
            <Badge variant="secondary" className="text-xs tabular-nums">
              x{group.agents.length}
            </Badge>
          )
        }
        footer={
          <div className="flex items-center justify-between text-xs text-muted-foreground w-full min-w-0">
            <div className="flex items-center -space-x-1.5">
              {creators.map((id) => (
                <User
                  key={id}
                  id={id}
                  size="3xs"
                  avatarOnly={creators.length > 1}
                />
              ))}
            </div>
            <span className="shrink-0 ml-2">
              {recentTs ? formatTimeAgo(new Date(recentTs)) : "—"}
            </span>
          </div>
        }
      />

      {isMobile ? (
        <Sheet open={dialogOpen} onOpenChange={setDialogOpen}>
          <SheetContent
            side="bottom"
            className="p-0 flex flex-col max-h-[80vh]"
          >
            <SheetHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
              <div className="flex items-center gap-3">
                <AgentAvatar
                  icon={group.icon}
                  name={group.title}
                  size="md"
                  className="shrink-0"
                />
                <div>
                  <SheetTitle>
                    {group.title}
                    <Badge
                      variant="secondary"
                      className="ml-2 text-xs tabular-nums"
                    >
                      x{group.agents.length}
                    </Badge>
                  </SheetTitle>
                  <SheetDescription>
                    {group.agents.length} instances
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>
            <div className="divide-y overflow-auto">
              {group.agents.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-3 px-6 py-3 hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() => {
                    setDialogOpen(false);
                    onNavigate(a.id);
                  }}
                >
                  <AgentAvatar
                    icon={a.icon}
                    name={a.title}
                    size="sm"
                    className="shrink-0"
                  />
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground truncate">
                      {a.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                    <User id={a.created_by} size="3xs" />
                    <span>
                      {a.created_at
                        ? formatTimeAgo(new Date(a.created_at))
                        : "—"}
                    </span>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
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
                        onClick={() => {
                          setDialogOpen(false);
                          onNavigate(a.id);
                        }}
                      >
                        <Eye size={16} />
                        Open
                      </DropdownMenuItem>
                      {!isDecopilot(a.id) && (
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => onDelete(a)}
                        >
                          <Trash01 size={16} />
                          Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      ) : (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="sm:max-w-lg p-0 gap-0">
            <DialogHeader className="px-6 pt-6 pb-4">
              <div className="flex items-center gap-3">
                <AgentAvatar
                  icon={group.icon}
                  name={group.title}
                  size="md"
                  className="shrink-0"
                />
                <div>
                  <DialogTitle>
                    {group.title}
                    <Badge
                      variant="secondary"
                      className="ml-2 text-xs tabular-nums"
                    >
                      x{group.agents.length}
                    </Badge>
                  </DialogTitle>
                  <DialogDescription>
                    {group.agents.length} instances
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="divide-y max-h-80 overflow-auto">
              {group.agents.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-3 px-6 py-3 hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() => {
                    setDialogOpen(false);
                    onNavigate(a.id);
                  }}
                >
                  <AgentAvatar
                    icon={a.icon}
                    name={a.title}
                    size="sm"
                    className="shrink-0"
                  />
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground truncate">
                      {a.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                    <User id={a.created_by} size="3xs" />
                    <span>
                      {a.created_at
                        ? formatTimeAgo(new Date(a.created_at))
                        : "—"}
                    </span>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
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
                        onClick={() => {
                          setDialogOpen(false);
                          onNavigate(a.id);
                        }}
                      >
                        <Eye size={16} />
                        Open
                      </DropdownMenuItem>
                      {!isDecopilot(a.id) && (
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => onDelete(a)}
                        >
                          <Trash01 size={16} />
                          Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Floating bulk action bar
// ---------------------------------------------------------------------------

function BulkActionBar({
  count,
  total,
  onSelectAll,
  onDeselectAll,
  onDelete,
  onCancel,
}: {
  count: number;
  total: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 flex items-center gap-3 rounded-xl border border-border bg-background/95 backdrop-blur px-4 py-2.5 shadow-lg">
      <span className="text-sm font-medium tabular-nums">{count} selected</span>
      <div className="h-4 w-px bg-border" />
      {count < total ? (
        <Button variant="ghost" size="sm" onClick={onSelectAll}>
          Select all ({total})
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={onDeselectAll}>
          Clear selection
        </Button>
      )}
      <div className="h-4 w-px bg-border" />
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={onDelete}
      >
        <Trash01 size={14} />
        Delete
      </Button>
      <div className="h-4 w-px bg-border" />
      <Button variant="ghost" size="sm" onClick={onCancel}>
        <XClose size={14} />
        Cancel
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grouped agent table (table view with accordion)
// ---------------------------------------------------------------------------

function GroupedAgentTable({
  columns,
  grouped,
  sortKey,
  sortDirection,
  onSort,
  onRowClick,
  selectionMode,
  selectedIds,
  onToggleSelect,
  emptyState,
}: {
  columns: TableColumn<VirtualMCPEntity>[];
  grouped: GroupedItem[];
  sortKey?: string;
  sortDirection?: "asc" | "desc" | null;
  onSort?: (key: string) => void;
  onRowClick: (agent: VirtualMCPEntity) => void;
  selectionMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  emptyState?: React.ReactNode;
}) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (grouped.length === 0 && emptyState) {
    return (
      <div className="flex items-center justify-center h-full">
        {emptyState}
      </div>
    );
  }

  const colCount = columns.length;

  return (
    <div className="flex-1 overflow-auto">
      <UITable className="w-full border-collapse">
        <TableHeader className="border-b-0">
          <TableRow className="h-9 hover:bg-transparent border-b border-border">
            {columns.map((col, idx) => {
              const isActiveSort = sortKey === col.id;
              const headerBase =
                "px-4 py-2 text-left font-mono font-normal text-muted-foreground text-[11px] h-9 uppercase tracking-wider";
              const isLast = idx === colCount - 1;
              return (
                <TableHead
                  key={col.id}
                  className={cn(
                    headerBase,
                    isLast && "w-8",
                    "group transition-colors select-none",
                    col.sortable && "hover:bg-accent cursor-pointer",
                    col.cellClassName,
                  )}
                  onClick={
                    col.sortable && onSort ? () => onSort(col.id) : undefined
                  }
                >
                  <span className="flex items-center gap-1">
                    {col.header}
                    {col.sortable && (
                      <span className="w-4 flex items-center justify-center">
                        {isActiveSort &&
                          sortDirection &&
                          (sortDirection === "asc" ? (
                            <ArrowUp
                              size={16}
                              className="text-muted-foreground"
                            />
                          ) : (
                            <ArrowDown
                              size={16}
                              className="text-muted-foreground"
                            />
                          ))}
                      </span>
                    )}
                  </span>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {grouped.map((item) => {
            if (item.type === "single") {
              const a = item.agent;
              return (
                <TableRow
                  key={a.id}
                  className={cn(
                    "group/data-row transition-colors border-b-0 hover:bg-accent/50 cursor-pointer",
                    selectionMode && selectedIds.has(a.id) && "bg-primary/5",
                  )}
                  onClick={() => onRowClick(a)}
                >
                  {columns.map((col) => (
                    <TableCell
                      key={col.id}
                      className={cn(
                        "px-5 py-4 h-16 align-middle text-sm text-foreground",
                        col.cellClassName,
                      )}
                    >
                      <div className="min-w-0 w-full truncate overflow-hidden whitespace-nowrap">
                        {col.render ? col.render(a) : null}
                      </div>
                    </TableCell>
                  ))}
                </TableRow>
              );
            }

            const group = item;
            const isExpanded = expandedGroups.has(group.key);
            const allSelected = group.agents.every((a) =>
              selectedIds.has(a.id),
            );
            const someSelected = group.agents.some((a) =>
              selectedIds.has(a.id),
            );
            const creators = getUniqueCreators(group.agents);

            const mostRecent = group.agents.reduce((latest, a) => {
              const t = a.updated_at ?? a.created_at;
              const l = latest.updated_at ?? latest.created_at;
              if (!t) return latest;
              if (!l) return a;
              return new Date(t) > new Date(l) ? a : latest;
            }, group.agents[0]!);

            return (
              <Fragment key={group.key}>
                <TableRow
                  className="border-b-0 hover:bg-accent/50 cursor-pointer transition-colors"
                  onClick={() => toggleGroup(group.key)}
                >
                  {columns.map((col) => {
                    const base = cn(
                      "px-5 py-3 h-14 align-middle text-sm",
                      col.cellClassName,
                    );

                    if (col.id === "select") {
                      return (
                        <TableCell key={col.id} className={base}>
                          <Checkbox
                            checked={
                              allSelected
                                ? true
                                : someSelected
                                  ? "indeterminate"
                                  : false
                            }
                            onCheckedChange={() => {
                              for (const a of group.agents) {
                                if (allSelected) {
                                  if (selectedIds.has(a.id))
                                    onToggleSelect(a.id);
                                } else {
                                  if (!selectedIds.has(a.id))
                                    onToggleSelect(a.id);
                                }
                              }
                            }}
                            onClick={(e: React.MouseEvent) =>
                              e.stopPropagation()
                            }
                          />
                        </TableCell>
                      );
                    }

                    if (col.id === "title") {
                      return (
                        <TableCell key={col.id} className={base}>
                          <div className="flex items-center gap-2 min-w-0">
                            <AgentAvatar
                              icon={group.icon}
                              name={group.title}
                              size="sm"
                            />
                            <span className="text-sm font-medium text-foreground truncate">
                              {group.title}
                            </span>
                            <Badge
                              variant="secondary"
                              className="text-xs tabular-nums"
                            >
                              x{group.agents.length}
                            </Badge>
                          </div>
                        </TableCell>
                      );
                    }

                    if (col.id === "updated_by") {
                      return (
                        <TableCell key={col.id} className={base}>
                          <div className="flex items-center -space-x-1.5">
                            {creators.map((id) => (
                              <User
                                key={id}
                                id={id}
                                size="3xs"
                                avatarOnly={creators.length > 1}
                              />
                            ))}
                          </div>
                        </TableCell>
                      );
                    }

                    if (col.id === "updated_at") {
                      const ts = mostRecent.updated_at ?? mostRecent.created_at;
                      return (
                        <TableCell key={col.id} className={base}>
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {ts ? formatTimeAgo(new Date(ts)) : "—"}
                          </span>
                        </TableCell>
                      );
                    }

                    if (col.id === "actions") {
                      return (
                        <TableCell key={col.id} className={base}>
                          <ChevronDown
                            size={16}
                            className={cn(
                              "text-muted-foreground transition-transform",
                              isExpanded && "rotate-180",
                            )}
                          />
                        </TableCell>
                      );
                    }

                    return <TableCell key={col.id} className={base} />;
                  })}
                </TableRow>

                {isExpanded &&
                  group.agents.map((a) => (
                    <TableRow
                      key={a.id}
                      className={cn(
                        "group/data-row transition-colors border-b-0 hover:bg-accent/50 cursor-pointer bg-muted/20",
                        selectionMode &&
                          selectedIds.has(a.id) &&
                          "bg-primary/5",
                      )}
                      onClick={() => onRowClick(a)}
                    >
                      {columns.map((col) => (
                        <TableCell
                          key={col.id}
                          className={cn(
                            "px-5 py-3 h-14 align-middle text-sm text-foreground",
                            col.cellClassName,
                            col.id === "title" && "pl-12",
                          )}
                        >
                          <div className="min-w-0 w-full truncate overflow-hidden whitespace-nowrap">
                            {col.render ? col.render(a) : null}
                          </div>
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
              </Fragment>
            );
          })}
        </TableBody>
      </UITable>
    </div>
  );
}

// ===========================================================================

function OrgAgentsContent() {
  const { org } = useProjectContext();
  const navigate = useNavigate();

  const listState = useListState<VirtualMCPEntity>({
    namespace: org.slug,
    resource: "agents",
    defaultViewMode: "cards",
  });

  const virtualMcps = useVirtualMCPs(listState);
  const { createVirtualMCP, isCreating } = useCreateVirtualMCP({
    navigateOnCreate: true,
  });
  const actions = useVirtualMCPActions();

  const [dialogState, dispatch] = useReducer(dialogReducer, { mode: "idle" });

  // Bulk selection state
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const filteredAgents = virtualMcps;

  // Grouped items
  const grouped = groupAgents(filteredAgents);

  // Stats
  const stats = {
    total: virtualMcps.length,
    active: virtualMcps.filter((a) => a.status === "active").length,
    inactive: virtualMcps.filter((a) => a.status === "inactive").length,
  };

  // Delete handlers
  const confirmDelete = async () => {
    if (dialogState.mode !== "deleting") return;
    const id = dialogState.virtualMcp.id;
    dispatch({ type: "close" });
    if (!id || isDecopilot(id)) return;
    try {
      await actions.delete.mutateAsync(id);
    } catch {
      // Error toast handled by mutation
    }
  };

  const handleBulkDelete = async () => {
    setBulkDeleteOpen(false);
    let deleted = 0;
    for (const id of selectedIds) {
      if (isDecopilot(id)) continue;
      try {
        await actions.delete.mutateAsync(id);
        deleted++;
      } catch {
        // continue
      }
    }
    toast.success(`Deleted ${deleted} agent${deleted !== 1 ? "s" : ""}`);
    exitSelectionMode();
  };

  const navigateToAgent = (agentId: string) => {
    if (selectionMode) {
      toggleSelect(agentId);
      return;
    }
    navigate({
      to: "/$org/agents/$agentId",
      params: {
        org: org.slug,
        agentId,
      },
    });
  };

  // Columns
  const columns: TableColumn<VirtualMCPEntity>[] = [
    ...(selectionMode
      ? [
          {
            id: "select",
            header: "",
            render: (agent: VirtualMCPEntity) => (
              <Checkbox
                checked={selectedIds.has(agent.id)}
                onCheckedChange={() => toggleSelect(agent.id)}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
              />
            ),
            cellClassName: "w-10 shrink-0",
          } satisfies TableColumn<VirtualMCPEntity>,
        ]
      : []),
    {
      id: "title",
      header: "Name",
      render: (virtualMcp) => (
        <div className="flex items-center gap-2 min-w-0">
          <AgentAvatar
            icon={virtualMcp.icon}
            name={virtualMcp.title}
            size="sm"
          />
          <span className="text-sm font-medium text-foreground truncate">
            {virtualMcp.title}
          </span>
        </div>
      ),
      cellClassName: "w-48 min-w-0 shrink-0",
      sortable: true,
    },
    {
      id: "description",
      header: "Description",
      render: (virtualMcp) => (
        <span className="text-sm text-foreground line-clamp-2">
          {virtualMcp.description || "—"}
        </span>
      ),
      cellClassName: "flex-1 min-w-0",
      wrap: true,
      sortable: true,
    },
    {
      id: "connections",
      header: "Connections",
      render: (virtualMcp) => (
        <Suspense fallback={<AgentConnectionsPreview.Fallback />}>
          <AgentConnectionsPreview
            connectionIds={virtualMcp.connections.map((c) => c.connection_id)}
            maxVisibleIcons={2}
          />
        </Suspense>
      ),
      cellClassName: "w-28 shrink-0",
    },
    {
      id: "status",
      header: "Status",
      render: (virtualMcp) => <ConnectionStatus status={virtualMcp.status} />,
      cellClassName: "w-24 shrink-0",
    },
    {
      id: "updated_by",
      header: "Updated by",
      render: (virtualMcp) => (
        <User id={virtualMcp.updated_by ?? virtualMcp.created_by} size="3xs" />
      ),
      cellClassName: "w-32 shrink-0",
      sortable: true,
    },
    {
      id: "updated_at",
      header: "Updated",
      render: (virtualMcp) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {virtualMcp.updated_at
            ? formatTimeAgo(new Date(virtualMcp.updated_at))
            : "—"}
        </span>
      ),
      cellClassName: "max-w-24 w-24 shrink-0",
      sortable: true,
    },
    {
      id: "actions",
      header: "",
      render: (virtualMcp) => (
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
                navigateToAgent(virtualMcp.id);
              }}
            >
              <Eye size={16} />
              Open
            </DropdownMenuItem>
            {!isDecopilot(virtualMcp.id) && (
              <DropdownMenuItem
                variant="destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: "delete", virtualMcp });
                }}
              >
                <Trash01 size={16} />
                Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
      cellClassName: "w-12 shrink-0",
    },
  ];

  const ctaButton = (
    <div className="flex items-center gap-2">
      {selectionMode ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-3 rounded-lg text-sm font-medium"
          onClick={exitSelectionMode}
        >
          <XClose size={14} />
          Cancel
        </Button>
      ) : (
        <>
          <Button
            variant="outline"
            size="sm"
            className="hidden sm:flex h-7 w-7 px-0 sm:w-auto sm:px-3 rounded-lg text-sm font-medium"
            onClick={() => setSelectionMode(true)}
          >
            <CheckSquare size={14} />
            <span className="hidden sm:inline">Select</span>
          </Button>
          <Button
            onClick={createVirtualMCP}
            size="sm"
            className="h-7 w-7 px-0 sm:w-auto sm:px-3 rounded-lg text-sm font-medium"
            disabled={isCreating}
          >
            <Plus size={14} />
            <span className="hidden sm:inline">
              {isCreating ? "Creating..." : "Create Agent"}
            </span>
          </Button>
        </>
      )}
    </div>
  );

  return (
    <Page>
      {/* Delete Confirmation Dialog (single) */}
      <AlertDialog
        open={dialogState.mode === "deleting"}
        onOpenChange={(open) => !open && dispatch({ type: "close" })}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Agent?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete{" "}
              <span className="font-medium text-foreground">
                {dialogState.mode === "deleting" &&
                  dialogState.virtualMcp.title}
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

      {/* Bulk Delete Confirmation Dialog */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedIds.size} agent{selectedIds.size !== 1 ? "s" : ""}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the
              selected agents.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Page Header */}
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage className="flex items-center gap-2">
                  Agents
                  <span className="hidden sm:inline text-xs font-normal text-muted-foreground tabular-nums">
                    {stats.total} total
                    {stats.active > 0 && ` · ${stats.active} active`}
                    {stats.inactive > 0 && ` · ${stats.inactive} inactive`}
                  </span>
                </BreadcrumbPage>
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
              { id: "description", label: "Description" },
              { id: "updated_by", label: "Updated by" },
              { id: "updated_at", label: "Updated" },
            ]}
          />
          {ctaButton}
        </Page.Header.Right>
      </Page.Header>

      {/* Search Bar */}
      <div className="flex items-center gap-3 px-5 pb-0">
        <div className="flex-1">
          <CollectionSearch
            value={listState.search}
            onChange={listState.setSearch}
            placeholder="Search for an agent..."
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                listState.setSearch("");
                (event.target as HTMLInputElement).blur();
              }
            }}
          />
        </div>
      </div>

      {/* Content: Cards or Table */}
      <Page.Content>
        {listState.viewMode === "cards" ? (
          <div className="flex-1 overflow-auto p-5">
            {filteredAgents.length === 0 ? (
              <div className="flex items-center justify-center min-h-[60vh]">
                <EmptyState
                  image={
                    <Users03 size={48} className="text-muted-foreground" />
                  }
                  title={listState.search ? "No agents found" : "No agents yet"}
                  description={
                    listState.search
                      ? `No agents match "${listState.search}"`
                      : "Create an agent to aggregate tools from multiple Connections."
                  }
                  actions={
                    !listState.search && (
                      <Button
                        size="sm"
                        onClick={createVirtualMCP}
                        disabled={isCreating}
                      >
                        <Plus size={14} />
                        {isCreating ? "Creating..." : "Create Agent"}
                      </Button>
                    )
                  }
                />
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
                {grouped.map((item) => {
                  if (item.type === "group") {
                    return (
                      <AgentGroupCard
                        key={item.key}
                        group={item}
                        onNavigate={navigateToAgent}
                        onDelete={(a) =>
                          dispatch({ type: "delete", virtualMcp: a })
                        }
                        selectionMode={selectionMode}
                        selectedIds={selectedIds}
                        onToggleSelect={toggleSelect}
                      />
                    );
                  }

                  const agent = item.agent;
                  return (
                    <div key={agent.id} className="relative">
                      {selectionMode && (
                        <div className="absolute top-3 left-3 z-10">
                          <Checkbox
                            checked={selectedIds.has(agent.id)}
                            onCheckedChange={() => toggleSelect(agent.id)}
                          />
                        </div>
                      )}
                      <ConnectionCard
                        connection={{
                          id: agent.id ?? "",
                          title: agent.title,
                          description: agent.description,
                          icon: agent.icon,
                          status: agent.status,
                        }}
                        fallbackIcon={<Users03 />}
                        onClick={() => navigateToAgent(agent.id)}
                        className={cn(
                          selectionMode &&
                            selectedIds.has(agent.id) &&
                            "ring-2 ring-primary",
                        )}
                        footer={
                          <div className="flex items-center justify-between text-xs text-muted-foreground w-full min-w-0">
                            <div className="flex-1 min-w-0">
                              <User
                                id={agent.updated_by ?? agent.created_by}
                                size="3xs"
                              />
                            </div>
                            <span className="shrink-0 ml-2">
                              {agent.updated_at
                                ? formatTimeAgo(new Date(agent.updated_at))
                                : "—"}
                            </span>
                          </div>
                        }
                        headerActions={
                          !selectionMode ? (
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
                                    navigateToAgent(agent.id);
                                  }}
                                >
                                  <Eye size={16} />
                                  Open
                                </DropdownMenuItem>
                                {!isDecopilot(agent.id) && (
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      dispatch({
                                        type: "delete",
                                        virtualMcp: agent,
                                      });
                                    }}
                                  >
                                    <Trash01 size={16} />
                                    Delete
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : undefined
                        }
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto min-w-0">
              {grouped.length === 0 ? (
                <div className="flex items-center justify-center min-h-[60vh]">
                  <EmptyState
                    image={
                      <Users03 size={48} className="text-muted-foreground" />
                    }
                    title={
                      listState.search ? "No agents found" : "No agents yet"
                    }
                    description={
                      listState.search
                        ? `No agents match "${listState.search}"`
                        : "Create an agent to aggregate tools from multiple Connections."
                    }
                    actions={
                      !listState.search && (
                        <Button
                          size="sm"
                          onClick={createVirtualMCP}
                          disabled={isCreating}
                        >
                          <Plus size={14} />
                          {isCreating ? "Creating..." : "Create Agent"}
                        </Button>
                      )
                    }
                  />
                </div>
              ) : (
                <div className="min-w-[1000px]">
                  <GroupedAgentTable
                    columns={columns}
                    grouped={grouped}
                    sortKey={listState.sortKey}
                    sortDirection={listState.sortDirection}
                    onSort={listState.handleSort}
                    onRowClick={(agent) => navigateToAgent(agent.id)}
                    selectionMode={selectionMode}
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </Page.Content>

      {/* Bulk Action Bar */}
      {selectionMode && (
        <BulkActionBar
          count={selectedIds.size}
          total={filteredAgents.length}
          onSelectAll={() =>
            setSelectedIds(new Set(filteredAgents.map((a) => a.id)))
          }
          onDeselectAll={() => setSelectedIds(new Set())}
          onDelete={() => setBulkDeleteOpen(true)}
          onCancel={exitSelectionMode}
        />
      )}
    </Page>
  );
}

export default function OrgAgents() {
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
        <OrgAgentsContent />
      </Suspense>
    </ErrorBoundary>
  );
}

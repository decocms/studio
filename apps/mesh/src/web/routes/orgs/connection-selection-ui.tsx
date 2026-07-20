import { ConnectionCard } from "@/web/components/connections/connection-card.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  type ConnectionEntity,
  type VirtualMCPEntity,
} from "@decocms/mesh-sdk";
import {
  CheckSquare,
  Container,
  DotsVertical,
  Eye,
  Plus,
  Power01,
  SlashCircle01,
  Trash01,
  XClose,
} from "@untitledui/icons";
import { useState } from "react";
import { type ConnectionGroup } from "@/shared/utils/group-connections";

// ---------------------------------------------------------------------------
// Grouped card: collapsible row for connections sharing the same app_name
// ---------------------------------------------------------------------------

export function ConnectionGroupCard({
  group,
  onOpen,
  selectionMode,
  selectedIds,
  onToggleSelect,
}: {
  group: ConnectionGroup;
  onOpen: () => void;
  selectionMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
}) {
  const allSelected = group.connections.every((c) => selectedIds.has(c.id));
  const someSelected = group.connections.some((c) => selectedIds.has(c.id));

  // Selecting the group toggles every connection to match: all-off -> all-on,
  // otherwise all-on -> all-off.
  const toggleGroupSelection = () => {
    for (const c of group.connections) {
      if (allSelected) {
        if (selectedIds.has(c.id)) onToggleSelect(c.id);
      } else {
        if (!selectedIds.has(c.id)) onToggleSelect(c.id);
      }
    }
  };

  return (
    <>
      <ConnectionCard
        connection={{
          title: group.title,
          icon: group.icon,
          description: `${group.connections.length} instances`,
        }}
        onClick={() => (selectionMode ? toggleGroupSelection() : onOpen())}
        className={cn(
          selectionMode && allSelected && "ring-2 ring-primary",
          selectionMode &&
            someSelected &&
            !allSelected &&
            "ring-1 ring-primary/50",
        )}
        fallbackIcon={<Container />}
        headerActionsAlwaysVisible
        headerActions={
          <div className="flex items-center gap-1">
            {selectionMode ? (
              <Checkbox
                checked={
                  allSelected ? true : someSelected ? "indeterminate" : false
                }
                onCheckedChange={toggleGroupSelection}
              />
            ) : (
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground font-normal">
                  Connected
                </span>
                <span className="text-xs text-muted-foreground font-normal tabular-nums">
                  x{group.connections.length}
                </span>
              </div>
            )}
            <div
              className={cn(
                "overflow-hidden transition-all duration-150 ease-out",
                selectionMode
                  ? "w-8 opacity-100"
                  : "w-0 opacity-0 group-hover:w-8 group-hover:opacity-100",
              )}
            >
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
                      onOpen();
                    }}
                  >
                    <Eye size={16} />
                    Open
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Header actions dropdown for a single connected card (Open / Select /
// Enable-Disable / Delete)
// ---------------------------------------------------------------------------

export function ConnectionCardHeaderActions({
  connection,
  isSelected,
  selectionMode,
  canManage,
  canManageAgents,
  onToggleSelect,
  onOpen,
  onToggleStatus,
  onDelete,
}: {
  connection: ConnectionEntity;
  isSelected: boolean;
  selectionMode: boolean;
  canManage: boolean;
  canManageAgents: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onToggleStatus: (status: "active" | "inactive") => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {selectionMode ? (
        <Checkbox
          checked={isSelected}
          onCheckedChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="text-xs text-muted-foreground font-normal">
          Connected
        </span>
      )}
      <div
        className={cn(
          "overflow-hidden transition-all duration-150 ease-out",
          selectionMode
            ? "w-8 opacity-100"
            : "w-0 opacity-0 group-hover:w-8 group-hover:opacity-100",
        )}
      >
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
                onOpen();
              }}
            >
              <Eye size={16} />
              Open
            </DropdownMenuItem>
            {(canManage || canManageAgents) && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelect();
                }}
              >
                <CheckSquare size={16} />
                Select
              </DropdownMenuItem>
            )}
            {canManage &&
              (connection.status === "active" ? (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleStatus("inactive");
                  }}
                >
                  <SlashCircle01 size={16} />
                  Disable
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleStatus("active");
                  }}
                >
                  <Power01 size={16} />
                  Enable
                </DropdownMenuItem>
              ))}
            {canManage && (
              <DropdownMenuItem
                variant="destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
              >
                <Trash01 size={16} />
                Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Floating bulk action bar (centered, same pattern as private-registry)
// ---------------------------------------------------------------------------

export function BulkActionBar({
  count,
  total,
  canManage,
  canManageAgents,
  onSelectAll,
  onDeselectAll,
  onDelete,
  onAddToAgent,
  onToggleStatus,
  onCancel,
}: {
  count: number;
  total: number;
  canManage: boolean;
  canManageAgents: boolean;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onDelete: () => void;
  onAddToAgent: () => void;
  onToggleStatus: (status: "active" | "inactive") => void;
  onCancel: () => void;
}) {
  if (count === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
      <div className="rounded-xl border border-border bg-background/95 shadow-lg backdrop-blur px-3 py-2 flex items-center gap-2">
        <div className="text-xs text-muted-foreground pr-1 tabular-nums">
          {count} selected
        </div>
        {count < total ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs px-2"
            onClick={onSelectAll}
          >
            Select all ({total})
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs px-2"
            onClick={onDeselectAll}
          >
            Clear selection
          </Button>
        )}
        {canManageAgents && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs px-2"
            onClick={onAddToAgent}
          >
            <Plus size={13} />
            Add to Agent
          </Button>
        )}
        {canManage && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs px-2"
              onClick={() => onToggleStatus("active")}
            >
              Enable
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs px-2"
              onClick={() => onToggleStatus("inactive")}
            >
              Disable
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-7 text-xs px-2"
              onClick={onDelete}
            >
              <Trash01 size={13} />
              Delete
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs px-2"
          onClick={onCancel}
        >
          <XClose size={13} />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add to Agent dialog
// ---------------------------------------------------------------------------

export function AddToAgentDialog({
  open,
  onOpenChange,
  agents,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: VirtualMCPEntity[];
  onConfirm: (agentId: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Add to Agent</DialogTitle>
          <DialogDescription>
            Select an agent to add the selected connections to.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-60 overflow-auto py-2 space-y-1">
          {agents.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No agents found
            </p>
          ) : (
            agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => setSelected(agent.id)}
                className={cn(
                  "flex items-center gap-3 w-full rounded-md px-3 py-2 text-left transition-colors",
                  selected === agent.id
                    ? "bg-primary/10 ring-1 ring-primary"
                    : "hover:bg-muted/50",
                )}
              >
                <IntegrationIcon
                  icon={agent.icon}
                  name={agent.title}
                  size="sm"
                  className="shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{agent.title}</p>
                  {agent.description && (
                    <p className="text-xs text-muted-foreground truncate">
                      {agent.description}
                    </p>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!selected}
            onClick={() => {
              if (selected) {
                onConfirm(selected);
                onOpenChange(false);
                setSelected(null);
              }
            }}
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

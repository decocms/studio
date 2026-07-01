import { Plus } from "@untitledui/icons";
import type { DraggableAttributes } from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@deco/ui/components/context-menu.tsx";
import { AgentAvatar } from "@/web/components/agent-icon";
import { AgentGroupContextMenuItems } from "./agent-group-context-menu-items";

export interface AgentRowProps {
  virtualMcpId: string;
  /** Highlighted when the active thread belongs to this agent. */
  isActive: boolean;
  /** The current user's thread count for this agent (shown at rest). */
  threadCount?: number;
  /** Click the row → open the agent (its most recent thread, or a new one). */
  onOpen: (virtualMcpId: string) => void;
  /** The hover "+" and context-menu "New task" → start a fresh thread. */
  onNewTask: (virtualMcpId: string) => void;
  onShowSettings: (virtualMcpId: string) => void;
  onHideGroup: (virtualMcpId: string) => void;
  isOrgPinned?: boolean;
  canManageOrgPin?: boolean;
  onToggleOrgPin?: (virtualMcpId: string, pinned: boolean) => void;
  /** When set, the row is draggable for reordering. */
  sortable?: {
    attributes: DraggableAttributes;
    listeners: SyntheticListenerMap | undefined;
    isDragging: boolean;
  };
}

export function AgentRow({
  virtualMcpId,
  isActive,
  threadCount,
  onOpen,
  onNewTask,
  onShowSettings,
  onHideGroup,
  isOrgPinned = false,
  canManageOrgPin = false,
  onToggleOrgPin,
  sortable,
}: AgentRowProps) {
  const entity = useVirtualMCP(virtualMcpId);
  const isDragging = sortable?.isDragging ?? false;
  const title = entity?.title ?? "Agent";

  const row = (
    <div
      {...(sortable ? { ...sortable.attributes, ...sortable.listeners } : {})}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(virtualMcpId)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(virtualMcpId);
        }
      }}
      className={cn(
        "group/group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium transition-colors",
        "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        sortable && "touch-none active:cursor-grabbing",
        isActive
          ? "bg-accent text-accent-foreground"
          : "text-foreground hover:bg-accent/60",
        isDragging && "shadow-md bg-accent/40 cursor-grabbing",
      )}
    >
      <AgentAvatar icon={entity?.icon ?? null} name={title} size="2xs" />
      <span className="flex-1 truncate">{title}</span>
      <div className="shrink-0 grid [grid-template-areas:'slot'] items-center justify-items-center">
        {typeof threadCount === "number" && threadCount > 0 && (
          <span className="[grid-area:slot] size-7 flex items-center justify-center text-xs text-muted-foreground tabular-nums transition-opacity group-hover/group:opacity-0">
            {threadCount}
          </span>
        )}
        <button
          type="button"
          aria-label="New thread with this agent"
          onClick={(e) => {
            e.stopPropagation();
            onNewTask(virtualMcpId);
          }}
          className="[grid-area:slot] size-7 flex items-center justify-center rounded-md opacity-0 group-hover/group:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <AgentGroupContextMenuItems
          virtualMcpId={virtualMcpId}
          isOrgPinned={isOrgPinned}
          canManageOrgPin={canManageOrgPin}
          onNewTaskInGroup={onNewTask}
          onShowSettings={onShowSettings}
          onToggleOrgPin={onToggleOrgPin ?? (() => {})}
          onHideGroup={onHideGroup}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

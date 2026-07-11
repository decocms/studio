import { useVirtualMCP } from "@decocms/mesh-sdk";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@deco/ui/components/context-menu.tsx";
import { AgentAvatar } from "@/web/components/agent-icon";
import { AgentGroupContextMenuItems } from "./agent-group-context-menu-items";
import type { AgentRowProps } from "./agent-row";
import type { TaskGroupData } from "./group-threads";

/**
 * Icons-only grid of agents — packs far more agents into the same space than
 * the list. Name shows on hover (native title). Reuses the same open/context
 * handlers as the list via `renderGroup`. No drag-reorder here (list view owns
 * ordering).
 */
function AgentIconCell(props: AgentRowProps) {
  const { virtualMcpId, isActive, onOpen } = props;
  const entity = useVirtualMCP(virtualMcpId);
  const title = entity?.title ?? "Agent";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          title={title}
          aria-label={title}
          onClick={() => onOpen(virtualMcpId)}
          className={cn(
            "flex items-center justify-center p-1 rounded-md transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            isActive ? "bg-accent" : "hover:bg-accent/60",
          )}
        >
          <AgentAvatar icon={entity?.icon ?? null} name={title} size="xs" />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <AgentGroupContextMenuItems
          virtualMcpId={virtualMcpId}
          isOrgPinned={props.isOrgPinned ?? false}
          canManageOrgPin={props.canManageOrgPin ?? false}
          onNewTaskInGroup={props.onNewTask}
          onShowSettings={props.onShowSettings}
          onToggleOrgPin={props.onToggleOrgPin ?? (() => {})}
          onHideGroup={props.onHideGroup}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function AgentIconGrid({
  groups,
  renderGroup,
}: {
  groups: TaskGroupData[];
  renderGroup: (group: TaskGroupData) => AgentRowProps;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(1.75rem,1fr))] gap-1 px-2 py-0.5">
      {groups.map((group) => {
        const props = renderGroup(group);
        return <AgentIconCell key={props.virtualMcpId} {...props} />;
      })}
    </div>
  );
}

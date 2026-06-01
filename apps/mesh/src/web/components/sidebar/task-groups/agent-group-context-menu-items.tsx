import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@deco/ui/components/context-menu.tsx";
import { EyeOff, Pin01, Plus, Settings02 } from "@untitledui/icons";

export interface AgentGroupContextMenuItemsProps {
  virtualMcpId: string;
  isOrgPinned: boolean;
  canManageOrgPin: boolean;
  onNewTaskInGroup: (virtualMcpId: string) => void;
  onShowSettings: (virtualMcpId: string) => void;
  onToggleOrgPin: (virtualMcpId: string, pinned: boolean) => void;
  onHideGroup: (virtualMcpId: string) => void;
}

export function AgentGroupContextMenuItems({
  virtualMcpId,
  isOrgPinned,
  canManageOrgPin,
  onNewTaskInGroup,
  onShowSettings,
  onToggleOrgPin,
  onHideGroup,
}: AgentGroupContextMenuItemsProps) {
  return (
    <>
      <ContextMenuItem onSelect={() => onNewTaskInGroup(virtualMcpId)}>
        <Plus size={14} className="mr-2" />
        New task
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onShowSettings(virtualMcpId)}>
        <Settings02 size={14} className="mr-2" />
        Settings
      </ContextMenuItem>
      {canManageOrgPin && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => onToggleOrgPin(virtualMcpId, !isOrgPinned)}
          >
            <Pin01 size={14} className="mr-2" />
            {isOrgPinned ? "Unpin for all members" : "Pin for all members"}
          </ContextMenuItem>
        </>
      )}
      {!isOrgPinned && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => onHideGroup(virtualMcpId)}>
            <EyeOff size={14} className="mr-2" />
            Hide
          </ContextMenuItem>
        </>
      )}
    </>
  );
}

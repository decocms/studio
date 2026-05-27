import { Edit05, MessageCircle01 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";
import { track } from "@/web/lib/posthog-client";

export interface ToggleButtonsProps {
  chatOpen: boolean;
  toggleChat: () => void;
  onNewTask?: () => void;
}

export function ToggleButtons({
  chatOpen,
  toggleChat,
  onNewTask,
}: ToggleButtonsProps) {
  return (
    <>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <ToolbarIconButton
            onClick={() => {
              track("agent_toolbar_toggled", {
                button: "chat",
                next_state: !chatOpen ? "open" : "closed",
              });
              toggleChat();
            }}
            aria-pressed={chatOpen}
            aria-label="Chat"
            active={chatOpen}
          >
            <MessageCircle01 size={16} />
          </ToolbarIconButton>
        </TooltipTrigger>
        <TooltipContent side="bottom">Chat</TooltipContent>
      </Tooltip>
      {onNewTask && (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <ToolbarIconButton onClick={onNewTask} aria-label="New task">
              <Edit05 size={16} />
            </ToolbarIconButton>
          </TooltipTrigger>
          <TooltipContent side="bottom">New task</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

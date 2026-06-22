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
  /**
   * When true, render the New task button before the Chat button. Used on
   * mobile, where new thread sits on the left and chat on the right.
   */
  newTaskFirst?: boolean;
}

export function ToggleButtons({
  chatOpen,
  toggleChat,
  onNewTask,
  newTaskFirst = false,
}: ToggleButtonsProps) {
  const chatButton = (
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
  );

  const newTaskButton = onNewTask && (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <ToolbarIconButton onClick={onNewTask} aria-label="New task">
          <Edit05 size={16} />
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">New task</TooltipContent>
    </Tooltip>
  );

  return (
    <>
      {newTaskFirst ? (
        <>
          {newTaskButton}
          {chatButton}
        </>
      ) : (
        <>
          {chatButton}
          {newTaskButton}
        </>
      )}
    </>
  );
}

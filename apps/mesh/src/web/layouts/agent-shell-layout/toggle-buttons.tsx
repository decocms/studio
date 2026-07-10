import { MessageCircle01 } from "@untitledui/icons";
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
  /**
   * When true, the chat toggle is disabled — chat is the only visible panel,
   * so turning it off would leave a blank content area.
   */
  disableChatToggle?: boolean;
}

/**
 * Top-toolbar chat toggle. (The New task action lives in the sidebar toolbar,
 * next to the thread list.)
 */
export function ToggleButtons({
  chatOpen,
  toggleChat,
  disableChatToggle = false,
}: ToggleButtonsProps) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          onClick={() => {
            if (disableChatToggle) return;
            track("agent_toolbar_toggled", {
              button: "chat",
              next_state: !chatOpen ? "open" : "closed",
            });
            toggleChat();
          }}
          disabled={disableChatToggle}
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
}

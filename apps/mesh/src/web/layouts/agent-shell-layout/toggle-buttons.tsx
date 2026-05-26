import { Edit05, MessageCircle01 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { track } from "@/web/lib/posthog-client";

export interface ToggleButtonsProps {
  chatOpen: boolean;
  toggleChat: () => void;
  onNewTask?: () => void;
}

const TOGGLE_BASE =
  "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors";
const TOGGLE_ACTIVE = "bg-sidebar-accent text-sidebar-foreground";
const TOGGLE_INACTIVE =
  "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground";

export function ToggleButtons({
  chatOpen,
  toggleChat,
  onNewTask,
}: ToggleButtonsProps) {
  return (
    <>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              track("agent_toolbar_toggled", {
                button: "chat",
                next_state: !chatOpen ? "open" : "closed",
              });
              toggleChat();
            }}
            aria-pressed={chatOpen}
            className={cn(
              TOGGLE_BASE,
              chatOpen ? TOGGLE_ACTIVE : TOGGLE_INACTIVE,
            )}
          >
            <MessageCircle01 size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Chat</TooltipContent>
      </Tooltip>
      {onNewTask && (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onNewTask}
              className={cn(TOGGLE_BASE, TOGGLE_INACTIVE)}
            >
              <Edit05 size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">New task</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

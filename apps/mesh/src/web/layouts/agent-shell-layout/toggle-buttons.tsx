/**
 * ToggleButtons — left/right panel toggles portal'd into the outer Toolbar.
 *
 * Renders the tasks toggle, chat toggle, and (when armed) the new-task
 * button. When the tasks panel is closed, the new-task button slides in
 * via a grid-cols animation so the shortcut is always reachable without
 * stealing visual weight when tasks are already visible.
 */

import { Edit05, Menu02, MessageCircle01 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { useTasksPanelState } from "@/web/hooks/use-tasks-panel-state";
import { track } from "@/web/lib/posthog-client";

export interface ToggleButtonsProps {
  chatOpen: boolean;
  toggleChat: () => void;
  /** When set, reveals an animated "new task" button next to the chat toggle. */
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
  const { tasksOpen, toggleTasks } = useTasksPanelState();
  const showNewTask = !!onNewTask;

  return (
    <>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              track("agent_toolbar_toggled", {
                button: "tasks",
                next_state: !tasksOpen ? "open" : "closed",
              });
              toggleTasks();
            }}
            aria-pressed={tasksOpen}
            className={cn(
              TOGGLE_BASE,
              tasksOpen ? TOGGLE_ACTIVE : TOGGLE_INACTIVE,
            )}
          >
            <Menu02 size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Tasks</TooltipContent>
      </Tooltip>
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
      <div
        className={cn(
          "grid transition-[grid-template-columns] duration-200 ease-[var(--ease-out-quart)]",
          showNewTask ? "grid-cols-[1fr]" : "grid-cols-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onNewTask}
                disabled={!showNewTask}
                tabIndex={showNewTask ? 0 : -1}
                aria-hidden={!showNewTask}
                className={cn(
                  TOGGLE_BASE,
                  TOGGLE_INACTIVE,
                  "transition-[transform,opacity] duration-200 ease-[var(--ease-out-quart)] will-change-transform",
                  showNewTask
                    ? "translate-x-0 opacity-100"
                    : "-translate-x-2 opacity-0",
                )}
              >
                <Edit05 size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New task</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </>
  );
}

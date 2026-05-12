/**
 * OrgHome — leaf component for /$org/. Renders HomePage inside the same
 * panel chrome the chat surface uses, full-bleed (no chat-main split).
 *
 * No Chat.Provider, no ActiveTaskProvider — the home composer is wired
 * to the home submit path (URL autosend handoff) via Chat.Input's
 * optional-context fallback.
 */

import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Menu02 } from "@untitledui/icons";
import { useTasksPanelState } from "@/web/hooks/use-tasks-panel-state";
import { track } from "@/web/lib/posthog-client";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import { HomePage } from "@/web/layouts/home-page";

const TOGGLE_BASE =
  "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors";
const TOGGLE_ACTIVE = "bg-sidebar-accent text-sidebar-foreground";
const TOGGLE_INACTIVE =
  "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground";

function HomeTasksToggle() {
  const { tasksOpen, toggleTasks } = useTasksPanelState();
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            track("home_toolbar_toggled", {
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
  );
}

export default function OrgHome() {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <div className="flex-1 min-h-0 flex flex-col bg-background overflow-hidden">
        <HomePage />
      </div>
    );
  }

  return (
    <>
      <Toolbar.Toggles>
        <HomeTasksToggle />
      </Toolbar.Toggles>
      <div className="flex-1 min-h-0 pb-1 pr-1 pl-0 pt-0">
        <div className="h-full p-0.5 pt-0.25">
          <div className="flex flex-col h-full bg-background overflow-hidden card-shadow rounded-[0.75rem]">
            <HomePage />
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The chat panel's threads menu — the thread list's home under the first-class
 * navigation (see `useNavV2`), where the sidebar lists destinations instead.
 *
 * It is the same list the sidebar used to render (`useThreadsPanel` +
 * `MyThreadsSection`), just anchored to an icon at the top of the chat.
 */

import { useState } from "react";
import {
  ChevronDown,
  Edit05,
  MessageTextSquare01,
  SearchSm,
} from "@untitledui/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { useOptionalChatTask } from "@/components/chat/context";
import { ThreadFiltersPopover } from "@/components/sidebar/task-groups/thread-filters-popover";
import {
  ThreadsPanelList,
  useThreadsPanel,
} from "@/components/sidebar/task-groups/use-threads-panel";
import { useT } from "@/i18n/use-t.ts";

export function ThreadsMenu() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const panel = useThreadsPanel({ onNavigate: () => setOpen(false) });
  /** Prefer the live active task (it re-titles as the run names the thread);
   *  fall back to the list row, which the filters may have dropped. */
  const activeTask = useOptionalChatTask()?.activeTask;
  const activeTitle =
    activeTask?.title ||
    panel.threads.find((thread) => thread.id === panel.activeTaskId)?.title ||
    t("tasksPanel.taskRow.untitledTask");

  const openSearch = () => {
    setOpen(false);
    panel.openSearch();
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t("chat.threadsMenu.chats")}
                className={cn(
                  "flex h-[34px] min-w-0 shrink items-center gap-1.5 rounded-lg px-2 text-sm text-foreground transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  open && "bg-sidebar-accent",
                )}
              >
                <MessageTextSquare01 size={16} className="shrink-0" />
                <span className="truncate max-w-[10rem] font-medium">
                  {activeTitle}
                </span>
                <ChevronDown
                  size={14}
                  className="shrink-0 text-muted-foreground opacity-70"
                />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("chat.threadsMenu.chats")}
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          align="start"
          side="bottom"
          // Autofocusing the filter button pops its tooltip over the list.
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="flex w-80 flex-col gap-2 p-2"
        >
          <div className="flex shrink-0 items-center justify-between">
            <ThreadFiltersPopover panel={panel} className="size-8 rounded-lg" />
            <div className="flex items-center gap-0.5">
              <ToolbarIconButton
                aria-label={t("sidebar.taskGroupsList.searchChats")}
                onClick={openSearch}
                className="size-8 rounded-lg"
              >
                <SearchSm size={16} />
              </ToolbarIconButton>
              <ToolbarIconButton
                aria-label={t("sidebar.taskGroupsList.newChat")}
                onClick={panel.newThread}
                className="size-8 rounded-lg"
              >
                <Edit05 size={16} />
              </ToolbarIconButton>
            </div>
          </div>
          <div className="flex max-h-[60vh] min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain">
            <ThreadsPanelList panel={panel} />
          </div>
        </PopoverContent>
      </Popover>
      {panel.searchDialog}
      {panel.reclaimDialog}
    </>
  );
}

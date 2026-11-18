/**
 * The chat panel's threads menu — the thread list's home, since the sidebar
 * lists destinations instead of threads.
 *
 * It is the same list the sidebar used to render (`useThreadsPanel` +
 * `MyThreadsSection`), just anchored to an icon at the top of the chat.
 */

import { useState } from "react";
import { ChevronDown, Edit05, SearchSm } from "@untitledui/icons";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
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

  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const list = needle
    ? {
        ...panel,
        threads: panel.threads.filter((thread) =>
          (thread.title ?? "").toLowerCase().includes(needle),
        ),
      }
    : panel;

  const openSearch = () => {
    setOpen(false);
    panel.openSearch(query.trim());
  };

  const changeOpen = (next: boolean) => {
    if (!next) setQuery("");
    setOpen(next);
  };

  return (
    <>
      <Popover open={open} onOpenChange={changeOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t("chat.threadsMenu.chats")}
                className={cn(
                  "flex h-[34px] min-w-0 shrink items-center gap-1.5 rounded-lg px-2 text-sm text-foreground transition-colors hover:bg-accent focus-ring",
                  open && "bg-sidebar-accent",
                )}
              >
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
          className="flex w-[26rem] max-w-[calc(100vw-2rem)] flex-col gap-2 p-2"
        >
          <div className="flex shrink-0 items-center gap-1">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={t("chat.threadsMenu.searchPlaceholder")}
              className="flex-1"
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  needle &&
                  list.threads.length === 0
                )
                  openSearch();
              }}
            />
            <ThreadFiltersPopover panel={panel} className="size-8" />
            <ToolbarIconButton
              aria-label={t("sidebar.taskGroupsList.newChat")}
              onClick={panel.newThread}
              className="size-8"
            >
              <Edit05 size={16} />
            </ToolbarIconButton>
          </div>
          <div className="flex max-h-[70vh] min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain">
            <ThreadsPanelList panel={list} />
          </div>
          {/* The list holds what's loaded; older chats come from the org-wide search. */}
          {needle && (
            <button
              type="button"
              onClick={openSearch}
              className="flex shrink-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <SearchSm size={14} className="shrink-0" />
              <span className="truncate">
                {t("chat.threadsMenu.searchEverywhere", {
                  query: query.trim(),
                })}
              </span>
            </button>
          )}
        </PopoverContent>
      </Popover>
      {panel.searchDialog}
    </>
  );
}

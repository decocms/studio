/**
 * Which task this chat is working in, and the way to switch.
 *
 * Replaces the branch selector in the workspace header. A task owns a branch and
 * holds the sessions that run on it, so the task is what you pick; the branch it
 * resolves to is a detail (it rides in the tooltip). A loose chat reads "No
 * task" and can join one, or become one, from the same menu.
 */

import { useState } from "react";
import { LayoutAlt01, Plus } from "@untitledui/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@decocms/ui/components/command.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { taskKey } from "@decocms/shared/task-key";
import { useOptionalChatTask } from "@/components/chat/context";
import { useOptionalThreadManager } from "@/components/chat/store/hooks";
import { useBoardTaskForThread } from "@/hooks/use-task-for-thread";
import { usePromoteThreadToTask } from "@/hooks/use-promote-thread-to-task";
import { useTaskBoardItems } from "@/hooks/use-task-board-items";
import { usePanelActions } from "@/layouts/shell-layout";
import {
  HIDDEN_STATUSES,
  STATUS_CONFIG,
  statusIconClassName,
  type TaskBoardItem,
} from "@/layouts/task-board/config";
import { resolveNewestSession } from "@/layouts/task-board/task-branch";
import { getActiveGithubRepo } from "@/lib/github-repo";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";

export function TaskPill({ placement }: { placement?: "chat" | "header" }) {
  const t = useT();
  const { org } = useProjectContext();
  const chatTask = useOptionalChatTask();
  const threadId = chatTask?.taskId;
  const virtualMcpId = chatTask?.virtualMcpId;
  const boardTask = useBoardTaskForThread(threadId);
  const { items } = useTaskBoardItems();
  const { setTaskId } = usePanelActions();
  const manager = useOptionalThreadManager();
  const promote = usePromoteThreadToTask();
  const agent = useVirtualMCP(virtualMcpId);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const isHeader = placement === "header";
  const key = boardTask ? taskKey(org.slug, boardTask.keySeq) : null;
  const label = boardTask
    ? `${key ? `${key} ` : ""}${boardTask.title}`
    : t("chat.taskPill.noTask");
  const StatusIcon = boardTask ? STATUS_CONFIG[boardTask.status].icon : null;
  const branch = manager?.threads
    .get()
    .find((row) => row.id === threadId)
    ?.branch?.trim();

  /** Switching task = opening its newest session, which carries its branch. */
  const openTask = (task: TaskBoardItem) => {
    setOpen(false);
    const newest = resolveNewestSession(task.threads);
    if (newest?.virtualMcpId) {
      setTaskId(newest.threadId, newest.virtualMcpId, {
        sidepanel: "chat",
        main: "board",
      });
      return;
    }
    setTaskId(threadId ?? "", virtualMcpId, { main: "board" });
  };

  const addThisChat = async () => {
    if (!threadId) return;
    setOpen(false);
    setPending(true);
    try {
      const thread = manager?.threads.get().find((row) => row.id === threadId);
      const repo = getActiveGithubRepo(agent);
      await promote({
        threadId,
        title: thread?.title?.trim() || t("thread.addToBoard.defaultTitle"),
        repo: repo ? `${repo.owner}/${repo.name}` : null,
      });
    } finally {
      setPending(false);
    }
  };

  const selectable = items.filter(
    (item) =>
      !HIDDEN_STATUSES.includes(item.status) && item.id !== boardTask?.id,
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="task-pill"
              disabled={pending}
              className={cn(
                "inline-flex min-w-0 max-w-[240px] items-center gap-1.5 rounded-md text-xs transition-colors",
                "hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                boardTask ? "text-foreground" : "text-muted-foreground",
                isHeader
                  ? "h-8 border border-input bg-background px-2.5"
                  : "h-9 px-2",
              )}
            >
              {StatusIcon && boardTask ? (
                <StatusIcon
                  size={14}
                  className={cn("shrink-0", statusIconClassName(boardTask))}
                />
              ) : (
                <LayoutAlt01 size={14} className="shrink-0" />
              )}
              <span className="min-w-0 truncate @max-3xl/panel-header:hidden">
                {label}
              </span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {branch
            ? t("chat.taskPill.tooltipWithBranch", { label, branch })
            : label}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-[320px] p-0">
        <Command>
          <CommandInput placeholder={t("chat.taskPill.searchPlaceholder")} />
          <CommandList>
            <CommandEmpty>{t("chat.taskPill.noneFound")}</CommandEmpty>
            {!boardTask && threadId && (
              <>
                <CommandGroup>
                  <CommandItem onSelect={() => void addThisChat()}>
                    <Plus size={16} />
                    {t("chat.taskPill.addThisChat")}
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            <CommandGroup heading={t("chat.taskPill.switchTo")}>
              {selectable.map((item) => {
                const itemKey = taskKey(org.slug, item.keySeq);
                const Icon = STATUS_CONFIG[item.status].icon;
                return (
                  <CommandItem
                    key={item.id}
                    value={`${itemKey ?? ""} ${item.title}`}
                    onSelect={() => openTask(item)}
                  >
                    <Icon
                      size={14}
                      className={cn("shrink-0", statusIconClassName(item))}
                    />
                    {itemKey && (
                      <span className="shrink-0 text-muted-foreground">
                        {itemKey}
                      </span>
                    )}
                    <span className="min-w-0 truncate">{item.title}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

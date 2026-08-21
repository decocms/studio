/**
 * The task's sessions, as tabs across the top of the chat panel.
 *
 * A task is a workspace holding N conversations on one branch, so switching
 * between them is a tab switch, not a navigation: the task, its branch, its
 * sandbox and its preview all stay put. Renders nothing when the current thread
 * belongs to no task — a loose chat has nothing to tab between, and
 * `ThreadsMenu` is its switcher.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DotsHorizontal, Plus, XClose } from "@untitledui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";
import { useOptionalChatTask } from "@/components/chat/context";
import { useThreadActions } from "@/components/chat/store/hooks";
import { useBoardTaskForThread } from "@/hooks/use-task-for-thread";
import { useStartTaskSession } from "@/hooks/use-start-task-session";
import { usePanelActions } from "@/layouts/shell-layout";
import { threadStatusStyle } from "@/layouts/task-board/config";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";

const MAX_VISIBLE_TABS = 3;

type TaskBoardItem = ToolOutput<"TASK_BOARD_ITEM_LIST">["items"][number];

export function SessionTabs() {
  const t = useT();
  const { locator } = useProjectContext();
  const queryClient = useQueryClient();
  const threadId = useOptionalChatTask()?.taskId;
  const boardTask = useBoardTaskForThread(threadId);
  const { setTaskId } = usePanelActions();
  const { rename, hide } = useThreadActions();
  const startSession = useStartTaskSession();
  const [renaming, setRenaming] = useState<string | null>(null);

  if (!boardTask || boardTask.threads.length === 0) return null;

  // Oldest first, so a tab never moves under the cursor as runs change status.
  const sessions = [...boardTask.threads].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  // Cap visible tabs so they don't shrink to unreadable slivers; the rest go in a dropdown.
  let visibleSessions = sessions;
  let overflowSessions: typeof sessions = [];
  if (sessions.length > MAX_VISIBLE_TABS) {
    const activeIndex = sessions.findIndex((s) => s.threadId === threadId);
    const start = Math.min(
      Math.max(0, sessions.length - MAX_VISIBLE_TABS),
      activeIndex < 0 ? Infinity : activeIndex,
    );
    const end = start + MAX_VISIBLE_TABS;
    visibleSessions = sessions.slice(start, end);
    overflowSessions = [...sessions.slice(0, start), ...sessions.slice(end)];
  }

  const closeSession = (session: (typeof sessions)[number]) => {
    queryClient.setQueryData<TaskBoardItem[]>(
      KEYS.taskBoardItems(locator),
      (prev) =>
        prev?.map((item) =>
          item.id === boardTask.id
            ? {
                ...item,
                threads: item.threads.filter(
                  (t) => t.threadId !== session.threadId,
                ),
              }
            : item,
        ),
    );
    void hide(session.threadId);
    if (session.threadId !== threadId) return;
    const next = sessions.find((s) => s.threadId !== session.threadId);
    if (next?.virtualMcpId) setTaskId(next.threadId, next.virtualMcpId);
  };

  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {visibleSessions.map((session) => {
        const active = session.threadId === threadId;
        const label = session.title || t("tasksPanel.taskRow.untitledTask");
        const state = session.status
          ? threadStatusStyle({ ...session, status: session.status }, t)
          : null;
        if (active && renaming === session.threadId) {
          return (
            <RenameField
              key={session.threadId}
              defaultValue={label}
              onCancel={() => setRenaming(null)}
              onCommit={(next) => {
                setRenaming(null);
                if (next && next !== label) void rename(session.threadId, next);
              }}
            />
          );
        }
        return (
          <div
            key={session.threadId}
            className={cn(
              "group/tab flex h-7 shrink-0 items-center rounded-lg px-2.5 text-sm transition-colors",
              active
                ? "bg-sidebar-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <button
              type="button"
              aria-current={active ? "page" : undefined}
              title={label}
              onClick={() => {
                if (active) {
                  setRenaming(session.threadId);
                  return;
                }
                if (session.virtualMcpId)
                  setTaskId(session.threadId, session.virtualMcpId);
              }}
              className="flex min-w-0 flex-1 items-center gap-1.5 focus-visible:outline-none"
            >
              {state && (
                <state.icon
                  size={14}
                  className={cn(
                    "shrink-0",
                    state.className,
                    state.spin && "animate-spin",
                  )}
                />
              )}
              <span className="max-w-[9rem] truncate group-hover/tab:max-w-[7rem]">
                {label}
              </span>
            </button>
            <button
              type="button"
              aria-label={t("chat.sessionTabs.closeSession")}
              onClick={() => closeSession(session)}
              className="flex w-0 shrink-0 items-center justify-center overflow-hidden opacity-0 transition-all focus-visible:outline-none group-hover/tab:ml-1 group-hover/tab:w-3.5 group-hover/tab:opacity-100"
            >
              <XClose size={13} />
            </button>
          </div>
        );
      })}
      {overflowSessions.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("chat.sessionTabs.moreSessions", {
                count: overflowSessions.length,
              })}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <DotsHorizontal size={16} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {overflowSessions.map((session) => {
              const label =
                session.title || t("tasksPanel.taskRow.untitledTask");
              const state = session.status
                ? threadStatusStyle({ ...session, status: session.status }, t)
                : null;
              return (
                <DropdownMenuItem
                  key={session.threadId}
                  onClick={() => {
                    if (session.virtualMcpId)
                      setTaskId(session.threadId, session.virtualMcpId);
                  }}
                >
                  {state && (
                    <state.icon
                      size={14}
                      className={cn(
                        state.className,
                        state.spin && "animate-spin",
                      )}
                    />
                  )}
                  <span className="max-w-[16rem] truncate">{label}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t("chat.sessionTabs.newSession")}
            onClick={() => void startSession(boardTask)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Plus size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("chat.sessionTabs.newSession")}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Inline rename on the active tab: clicking it again starts an edit. */
function RenameField({
  defaultValue,
  onCommit,
  onCancel,
}: {
  defaultValue: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  return (
    <input
      autoFocus
      defaultValue={defaultValue}
      onBlur={(e) => onCommit(e.currentTarget.value.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(e.currentTarget.value.trim());
        if (e.key === "Escape") onCancel();
      }}
      className="h-7 w-[9rem] min-w-0 rounded-lg bg-sidebar-accent px-2.5 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    />
  );
}

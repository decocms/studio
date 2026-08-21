/**
 * Which task the current chat is inside, and the way back to it.
 *
 * The chat panel is a global fixture: it sits beside preview, content and the
 * board alike, bound to whichever thread is in the URL. Without this, a session
 * that belongs to a task looks exactly like a loose chat.
 */

import { useNavigate } from "@tanstack/react-router";
import { cn } from "@decocms/ui/lib/utils.ts";
import { taskKey } from "@decocms/shared/task-key";
import { useChatTask } from "@/components/chat/chat-context";
import { useOptionalThreadManager } from "@/components/chat/store/hooks";
import { useBoardTaskForThread } from "@/hooks/use-task-for-thread";
import {
  STATUS_CONFIG,
  statusIconClassName,
} from "@/layouts/task-board/config";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";

export function TaskCrumb() {
  const t = useT();
  const { org } = useProjectContext();
  const { taskId } = useChatTask();
  const navigate = useNavigate();
  const boardTask = useBoardTaskForThread(taskId);
  const manager = useOptionalThreadManager();

  if (!boardTask) return null;

  /** The branch is a detail of the task now: it rides in the tooltip. */
  const branch = manager?.threads
    .get()
    .find((row) => row.id === taskId)
    ?.branch?.trim();

  // Null for a card written before the key backfill: fall back to the title.
  const key = taskKey(org.slug, boardTask.keySeq) ?? "";
  const StatusIcon = STATUS_CONFIG[boardTask.status].icon;

  return (
    <button
      type="button"
      title={[key, boardTask.title, branch].filter(Boolean).join(" · ")}
      aria-label={t("thread.taskCrumb.openTask", { key })}
      onClick={() =>
        navigate({
          to: ".",
          search: (prev: Record<string, unknown>) => ({
            ...prev,
            main: "board",
            task: boardTask.id,
          }),
        })
      }
      className="flex h-[34px] min-w-0 shrink items-center gap-1.5 rounded-lg px-2 text-sm text-foreground transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <StatusIcon
        size={16}
        className={cn("shrink-0", statusIconClassName(boardTask))}
      />
      {key && <span className="shrink-0 font-medium">{key}</span>}
      <span className="min-w-0 truncate text-muted-foreground">
        {boardTask.title}
      </span>
    </button>
  );
}

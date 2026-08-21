/**
 * Every PR opened from the product lands on the board.
 *
 * Publishing from the CMS or from a chat used to leave no trace on the board:
 * the work shipped and the card never existed, so the board stopped being the
 * record of what the team was doing. A PR is durable work by definition, so
 * this promotes the thread (or updates its existing card) the moment one opens.
 *
 * Shared by the chat publish dialog and the CMS publish popover because they
 * share `publish-flow.ts` — one meaning of "this shipped" for both.
 */

import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { taskKey } from "@decocms/shared/task-key";
import { useOptionalChatTask } from "@/components/chat/context";
import { useOptionalThreadManager } from "@/components/chat/store/hooks";
import { usePromoteThreadToTask } from "@/hooks/use-promote-thread-to-task";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";

export interface RecordPrInput {
  /** The PR that just opened. */
  url: string;
  /** `owner/name` of the repo it opened against. */
  repo?: string | null;
  /** True when the change is already merged (publish-and-merge). */
  merged?: boolean;
}

export function useRecordPrOnBoard() {
  const t = useT();
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const threadId = useOptionalChatTask()?.taskId;
  const manager = useOptionalThreadManager();
  const promote = usePromoteThreadToTask();

  return async (input: RecordPrInput) => {
    if (!threadId) return;
    try {
      const thread = manager?.threads.get().find((row) => row.id === threadId);
      const task = await promote({
        threadId,
        title: thread?.title?.trim() || t("thread.addToBoard.defaultTitle"),
        repo: input.repo ?? null,
        prUrl: input.url,
        status: input.merged ? "in_review" : "in_progress",
      });
      toast.success(
        t("thread.addToBoard.added", {
          key: taskKey(org.slug, task.keySeq) ?? task.title,
        }),
        {
          action: {
            label: t("thread.addToBoard.openTask"),
            onClick: () =>
              navigate({
                to: ".",
                search: (prev: Record<string, unknown>) => ({
                  ...prev,
                  main: "board",
                  task: task.id,
                }),
              }),
          },
        },
      );
    } catch {
      /* Publishing succeeded; failing to file the card must not read as a
         failed publish. The board reconciles on its next list. */
    }
  };
}

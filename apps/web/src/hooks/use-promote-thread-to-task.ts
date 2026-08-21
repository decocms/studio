/**
 * Put a chat's work on the board.
 *
 * The one bridge between a loose conversation and the board. Create-or-link,
 * never plain create: a thread that already has a card gets the new detail
 * added to it, or re-publishing the same branch would fill the board with
 * duplicates of one piece of work.
 */

import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";
import { useStudioTools } from "@/lib/studio-tools";
import { useTaskBoardItemActions } from "@/hooks/use-task-board-items";

type TaskBoardItem = ToolOutput<"TASK_BOARD_ITEM_LIST">["items"][number];
type TaskBoardItemStatus = TaskBoardItem["status"];

export interface PromoteInput {
  threadId: string;
  title: string;
  /** `owner/name`, when the thread is working in a repo. */
  repo?: string | null;
  /** A PR the work landed in. Recorded as a link in the card's description. */
  prUrl?: string | null;
  /** Where the card should land. Defaults to in progress. */
  status?: TaskBoardItemStatus;
}

export function usePromoteThreadToTask() {
  const studio = useStudioTools();
  const actions = useTaskBoardItemActions();

  return async (input: PromoteInput): Promise<TaskBoardItem> => {
    /* Existing card wins: keyed on the thread first, then on the PR url, so a
       second publish of the same work updates one card instead of adding one. */
    const items = await studio
      .call("TASK_BOARD_ITEM_LIST", {})
      .then((r) => r.items)
      .catch(() => [] as TaskBoardItem[]);
    const prUrl = input.prUrl;
    const existing =
      items.find((item) =>
        item.threads.some((t) => t.threadId === input.threadId),
      ) ??
      (prUrl
        ? items.find((item) => item.description?.includes(prUrl))
        : undefined);
    if (existing) {
      if (prUrl && !existing.description?.includes(prUrl)) {
        await actions.update.mutateAsync({
          id: existing.id,
          description: appendLink(existing.description, prUrl),
        });
      }
      await actions.link.mutateAsync({
        id: existing.id,
        linkThreadId: input.threadId,
      });
      return existing;
    }
    /* No assignee: the person is doing this by hand, and setting the Super
       Agent here would dispatch a second autonomous run over their work. */
    const { item: created } = await actions.create.mutateAsync({
      title: input.title,
      description: prUrl ? appendLink(null, prUrl) : null,
      status: input.status ?? "in_progress",
      repo: input.repo ?? null,
    });
    await actions.link.mutateAsync({
      id: created.id,
      linkThreadId: input.threadId,
    });
    return created;
  };
}

/** Keep the PR discoverable from the card: `LinksSection` renders description
 *  links as rows, so appending the url is enough to surface it. */
function appendLink(description: string | null, url: string): string {
  const body = description?.trimEnd();
  return body ? `${body}\n\n${url}` : url;
}

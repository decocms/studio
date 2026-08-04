/** A task's comment threads, plus the mutations that post, resolve and delete
 *  them. Comments come back flat and are nested here — a reply's `parentId` is
 *  always a thread root, so the tree is one level deep. */

import { useProjectContext } from "@/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";

export type TaskBoardComment =
  ToolOutput<"TASK_BOARD_COMMENT_LIST">["comments"][number];

/** A thread root with its replies, oldest first. */
export type TaskBoardCommentThread = TaskBoardComment & {
  replies: TaskBoardComment[];
};

export function nest(comments: TaskBoardComment[]): TaskBoardCommentThread[] {
  const threads = comments
    .filter((c) => !c.parentId)
    .map((root) => ({ ...root, replies: [] as TaskBoardComment[] }));
  const byId = new Map(threads.map((t) => [t.id, t]));
  for (const comment of comments) {
    if (comment.parentId) byId.get(comment.parentId)?.replies.push(comment);
  }
  return threads;
}

export function useTaskBoardComments(itemId: string | undefined) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const queryKey = KEYS.taskBoardComments(locator, itemId ?? "");

  const query = useQuery({
    queryKey,
    enabled: !!itemId,
    queryFn: async () =>
      nest(
        (
          await studio.call("TASK_BOARD_COMMENT_LIST", {
            taskBoardItemId: itemId!,
          })
        ).comments,
      ),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const post = useMutation({
    mutationFn: (input: { body: string; parentId?: string }) =>
      studio.call("TASK_BOARD_COMMENT_CREATE", {
        taskBoardItemId: itemId!,
        ...input,
      }),
    onSuccess: invalidate,
  });

  const setResolved = useMutation({
    mutationFn: (input: { id: string; resolved: boolean }) =>
      studio.call("TASK_BOARD_COMMENT_UPDATE", input),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      studio.call("TASK_BOARD_COMMENT_DELETE", { id }),
    onSuccess: invalidate,
  });

  return { threads: query.data ?? [], post, setResolved, remove };
}

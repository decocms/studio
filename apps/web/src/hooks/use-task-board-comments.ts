/**
 * Comments + attachments for one task board item. The dialog fetches these on
 * open; mutations invalidate the per-task query (no SSE — comments are a
 * dialog-scoped surface).
 */

import { useProjectContext } from "@/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import type {
  StudioToolInput as ToolInput,
  StudioToolOutput as ToolOutput,
} from "@decocms/shared/tools/tool-io";

export type TaskBoardComment =
  ToolOutput<"TASK_BOARD_COMMENT_LIST">["comments"][number];
export type TaskBoardAttachment =
  ToolOutput<"TASK_BOARD_ATTACHMENT_LIST">["attachments"][number];

/** URL serving an attachment's bytes (org-scoped, auth via session cookie). */
export function taskBoardAttachmentUrl(
  orgSlug: string,
  attachmentId: string,
): string {
  return `/api/${encodeURIComponent(orgSlug)}/task-board/attachments/${attachmentId}`;
}

export function useTaskBoardComments(itemId: string | undefined) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.taskBoardComments(locator, itemId ?? ""),
    enabled: !!itemId,
    queryFn: async () =>
      (
        await studio.call("TASK_BOARD_COMMENT_LIST", {
          taskBoardItemId: itemId!,
        })
      ).comments,
  });
}

export function useTaskBoardAttachments(itemId: string | undefined) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.taskBoardAttachments(locator, itemId ?? ""),
    enabled: !!itemId,
    queryFn: async () =>
      (
        await studio.call("TASK_BOARD_ATTACHMENT_LIST", {
          taskBoardItemId: itemId!,
        })
      ).attachments,
  });
}

export function useTaskBoardCommentActions(itemId: string | undefined) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const invalidate = () => {
    if (!itemId) return;
    queryClient.invalidateQueries({
      queryKey: KEYS.taskBoardComments(locator, itemId),
    });
    queryClient.invalidateQueries({
      queryKey: KEYS.taskBoardAttachments(locator, itemId),
    });
  };

  const create = useMutation({
    mutationFn: (
      input: Omit<ToolInput<"TASK_BOARD_COMMENT_CREATE">, "taskBoardItemId">,
    ) =>
      studio.call("TASK_BOARD_COMMENT_CREATE", {
        ...input,
        taskBoardItemId: itemId!,
      }),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: (input: { id: string; body: string }) =>
      studio.call("TASK_BOARD_COMMENT_UPDATE", input),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      studio.call("TASK_BOARD_COMMENT_DELETE", { id }),
    onSuccess: invalidate,
  });

  const addAttachment = useMutation({
    mutationFn: (
      input: Omit<ToolInput<"TASK_BOARD_ATTACHMENT_ADD">, "taskBoardItemId">,
    ) =>
      studio.call("TASK_BOARD_ATTACHMENT_ADD", {
        ...input,
        taskBoardItemId: itemId!,
      }),
    onSuccess: invalidate,
  });

  const removeAttachment = useMutation({
    mutationFn: (id: string) =>
      studio.call("TASK_BOARD_ATTACHMENT_DELETE", { id }),
    onSuccess: invalidate,
  });

  return { create, update, remove, addAttachment, removeAttachment };
}

/**
 * A task's comment threads, live over SSE.
 *
 * Reads `TASK_BOARD_COMMENT_LIST` once and then rides the shared
 * `/api/:org/watch` connection: `task-board.comment.created` appends the new
 * comment (a member's, or the Super Agent's answer to a mention) into the cache,
 * and `task-board.comment.agent-typing` tracks which threads the Super Agent is
 * currently answering so the feed can show it typing. No polling.
 *
 * Subscription plumbing mirrors `use-task-board-events.ts`: `subscribe` lives in
 * a ref rebuilt only when the connection identity (org, task) changes, so the
 * shared EventSource isn't torn down on every re-render. Nothing here needs a
 * fresh-callback ref — the handler writes straight to the query cache and to
 * this hook's own state, both stable.
 */

import { useProjectContext } from "@/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, useSyncExternalStore } from "react";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import type {
  StudioToolInput as ToolInput,
  StudioToolOutput as ToolOutput,
} from "@decocms/shared/tools/tool-io";
import { TASK_BOARD_COMMENT_CREATED_EVENT } from "@decocms/shared/task-board";
import { taskCommentsWatchView } from "./watch-sse-pool";

export type TaskBoardCommentRow =
  ToolOutput<"TASK_BOARD_COMMENT_LIST">["comments"][number];

type CommentMention = ToolInput<"TASK_BOARD_COMMENT_CREATE">["mentions"];

/** What the Super Agent typing event carries. */
interface AgentTypingPayload {
  taskBoardItemId: string;
  threadRootId: string;
  typing: boolean;
}

const getSnapshot = () => 0;

export function useTaskBoardComments(itemId: string) {
  const { org, locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const queryKey = KEYS.taskBoardComments(locator, itemId);

  const query = useQuery({
    queryKey,
    enabled: !!itemId,
    queryFn: async () =>
      (
        await studio.call("TASK_BOARD_COMMENT_LIST", {
          taskBoardItemId: itemId,
        })
      ).comments,
  });

  /** Thread roots the Super Agent is answering right now. */
  const [typingThreadIds, setTypingThreadIds] = useState<string[]>([]);

  const subscribeRef = useRef<
    ((onStoreChange: () => void) => () => void) | null
  >(null);
  const prevIdentity = useRef("");
  const identity = `${org.slug}:${itemId}`;

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
  if (!subscribeRef.current || prevIdentity.current !== identity) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
    prevIdentity.current = identity;
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
    subscribeRef.current = (onStoreChange: () => void) => {
      if (!org.slug || !itemId) return () => {};

      const handler = (e: MessageEvent) => {
        let event: { data?: unknown };
        try {
          event = JSON.parse(e.data) as { data?: unknown };
        } catch {
          return;
        }
        if (!event.data) return;

        if (e.type === TASK_BOARD_COMMENT_CREATED_EVENT) {
          const comment = event.data as TaskBoardCommentRow;
          if (comment.taskBoardItemId !== itemId) return;
          queryClient.setQueryData<TaskBoardCommentRow[]>(
            KEYS.taskBoardComments(locator, itemId),
            (prev) => {
              const rows = prev ?? [];
              return rows.some((c) => c.id === comment.id)
                ? rows.map((c) => (c.id === comment.id ? comment : c))
                : [...rows, comment];
            },
          );
          onStoreChange();
          return;
        }

        const typing = event.data as AgentTypingPayload;
        if (typing.taskBoardItemId !== itemId) return;
        setTypingThreadIds((prev) =>
          typing.typing
            ? prev.includes(typing.threadRootId)
              ? prev
              : [...prev, typing.threadRootId]
            : prev.filter((id) => id !== typing.threadRootId),
        );
        onStoreChange();
      };

      return taskCommentsWatchView.subscribe(org.slug, handler);
    };
  }

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- escape hatch for stable subscription identity
  useSyncExternalStore(subscribeRef.current!, getSnapshot, getSnapshot);

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  // The server pushes the stored comment back over SSE, so none of these
  // mutations paint an optimistic row — they'd only duplicate it.
  const create = useMutation({
    mutationFn: (input: {
      body: string;
      parentId?: string | null;
      mentions?: CommentMention;
    }) =>
      studio.call("TASK_BOARD_COMMENT_CREATE", {
        taskBoardItemId: itemId,
        ...input,
      }),
    onSettled: invalidate,
  });

  const update = useMutation({
    mutationFn: (input: ToolInput<"TASK_BOARD_COMMENT_UPDATE">) =>
      studio.call("TASK_BOARD_COMMENT_UPDATE", input),
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      studio.call("TASK_BOARD_COMMENT_DELETE", { id }),
    onSettled: invalidate,
  });

  return {
    comments: query.data ?? [],
    isLoading: query.isLoading,
    typingThreadIds,
    post: (body: string, mentions?: CommentMention) =>
      create.mutate({ body, mentions }),
    reply: (parentId: string, body: string, mentions?: CommentMention) =>
      create.mutate({ body, parentId, mentions }),
    setResolved: (id: string, resolved: boolean) =>
      update.mutate({ id, resolved }),
    remove: (id: string) => remove.mutate(id),
  };
}

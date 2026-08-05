import { useProjectContext } from "@/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import type {
  StudioToolInput as ToolInput,
  StudioToolOutput as ToolOutput,
} from "@decocms/shared/tools/tool-io";
import { useTaskBoardEvents } from "@/hooks/use-task-board-events";
import { useDecopilotEvents } from "@/hooks/use-decopilot-events";
import { useT } from "@/i18n/use-t";
import { toast } from "sonner";

type TaskBoardItem = ToolOutput<"TASK_BOARD_ITEM_LIST">["items"][number];

export function useTaskBoardItems() {
  const { org, locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const queryKey = KEYS.taskBoardItems(locator);

  const query = useQuery({
    queryKey,
    queryFn: async () => (await studio.call("TASK_BOARD_ITEM_LIST", {})).items,
  });

  // Live Super Agent transitions (todo → in_progress → in_review). Upsert the
  // pushed item into the cached list so the board moves cards without polling.
  useTaskBoardEvents({
    orgSlug: org.slug,
    onUpdate: (item) => {
      queryClient.setQueryData<TaskBoardItem[]>(queryKey, (prev) => {
        const next = prev ?? [];
        return next.some((t) => t.id === item.id)
          ? next.map((t) => (t.id === item.id ? item : t))
          : [item, ...next];
      });
      // Every pushed item change also appends to its timeline — refetch the
      // activity feed so a task dialog left open during a live transition
      // (e.g. a Super Agent status/assignee change) doesn't show a stale one.
      queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardActivity(locator, item.id),
      });
    },
    // Live deletes: drop the removed card so it clears on every open board.
    onDelete: (id) => {
      queryClient.setQueryData<TaskBoardItem[]>(queryKey, (prev) =>
        prev?.filter((t) => t.id !== id),
      );
    },
  });

  // Live run status of linked threads (in_progress / requires_action / …).
  // A task's card derives its "blocked, waiting for input" flag from a linked
  // thread's `requires_action` status; that transition rides the decopilot
  // thread-status SSE (it doesn't change the task's own lane), so patch the
  // matching thread's status straight into the cached item.
  useDecopilotEvents({
    orgSlug: org.slug,
    onTaskStatus: (event) => {
      const threadId = event.subject;
      const status = event.data.status;
      queryClient.setQueryData<TaskBoardItem[]>(queryKey, (prev) =>
        prev?.map((item) =>
          item.threads.some((t) => t.threadId === threadId)
            ? {
                ...item,
                threads: item.threads.map((t) =>
                  t.threadId === threadId ? { ...t, status } : t,
                ),
              }
            : item,
        ),
      );
    },
  });

  return {
    items: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

export function useTaskBoardItemActions() {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const t = useT();
  const queryKey = KEYS.taskBoardItems(locator);

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const create = useMutation({
    mutationFn: (input: ToolInput<"TASK_BOARD_ITEM_CREATE">) =>
      studio.call("TASK_BOARD_ITEM_CREATE", input),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: (input: ToolInput<"TASK_BOARD_ITEM_UPDATE">) =>
      studio.call("TASK_BOARD_ITEM_UPDATE", input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<TaskBoardItem[]>(queryKey);
      queryClient.setQueryData<TaskBoardItem[]>(queryKey, (prev) =>
        prev?.map((item) =>
          item.id === input.id ? { ...item, ...input } : item,
        ),
      );
      return { previous };
    },
    onError: (_err, _input, context) => {
      if (context?.previous)
        queryClient.setQueryData(queryKey, context.previous);
    },
    // A status/assignee change appends to the task's timeline — drop the
    // activity cache too so a reopened dialog shows the new entries.
    onSettled: (_data, _err, input) => {
      invalidate();
      queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardActivity(locator, input.id),
      });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => studio.call("TASK_BOARD_ITEM_DELETE", { id }),
    onSuccess: invalidate,
    // A rejected delete used to land nowhere: the dialog had already closed, so
    // a refused deletion read as a successful one. Surface it and refetch, so
    // the card the server kept comes back into the list.
    onError: (err: unknown) => {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t("taskBoard.taskBoard.deleteError"),
      );
      invalidate();
    },
  });

  // Bulk delete from the selection bar. Calls the tool directly rather than
  // fanning out through `remove` so a partly-failed batch reports one summary
  // instead of one toast per card.
  const removeMany = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => studio.call("TASK_BOARD_ITEM_DELETE", { id })),
      );
      return {
        total: ids.length,
        failed: results.filter((r) => r.status === "rejected").length,
      };
    },
    onSuccess: ({ total, failed }) => {
      if (failed === 0) return;
      toast.error(
        t("taskBoard.taskBoard.deleteBulkError", {
          failed: String(failed),
          total: String(total),
        }),
      );
    },
    onError: () => toast.error(t("taskBoard.taskBoard.deleteError")),
    onSettled: invalidate,
  });

  // Link a chat thread to a task (folded into UPDATE via linkThreadId). Kept as
  // its own mutation so it invalidates without the optimistic field-patch that
  // `update` applies.
  const link = useMutation({
    mutationFn: (input: { id: string; linkThreadId: string }) =>
      studio.call("TASK_BOARD_ITEM_UPDATE", input),
    onSuccess: invalidate,
  });

  return { create, update, remove, removeMany, link };
}

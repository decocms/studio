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
import type { Sprint } from "@decocms/shared/sprints";
import { useT } from "@/i18n/use-t";
import { track } from "@/lib/posthog-client";
import { toast } from "sonner";

type TaskBoardItem = ToolOutput<"TASK_BOARD_ITEM_LIST">["items"][number];

/**
 * What the board caches: the cards AND the sprints they can belong to.
 *
 * Both come from one `TASK_BOARD_ITEM_LIST` call, and a card carries only its
 * `sprintId` — caching the items alone would mean a second round trip (or a
 * second tool) just to turn that id into a name.
 */
type TaskBoardData = {
  items: TaskBoardItem[];
  sprints: ToolOutput<"TASK_BOARD_ITEM_LIST">["sprints"];
};

/**
 * The newest item the SSE stream pushed, per id — the board's guard against a
 * refetch answering with a row older than a transition it already rendered.
 *
 * "Click Auto-fix, the card jumps to In Progress and then falls back to To Do
 * until F5" is exactly that race: `TASK_BOARD_ITEM_UPDATE` persists the card in
 * `todo` and only then dispatches the run, which flips it to `in_progress` in a
 * later write. The board invalidates on the update's response, so its refetch
 * can read the DB between those two writes, land after the `in_progress` push,
 * and overwrite it with `todo`.
 *
 * Module-level rather than a ref: `useBoardSprintIndex` and `useTaskBoardItems`
 * share one query key, so whichever `queryFn` React Query keeps must apply the
 * same overlay.
 */
const liveItems = new Map<string, TaskBoardItem>();

/**
 * Overlay `liveItems` on a freshly fetched list, keeping whichever copy of each
 * card is newer. A tie goes to the server (same `updated_at` = same write) and
 * drops the live copy, so the map stays as small as the transitions in flight.
 */
export function mergeLiveItems(
  items: TaskBoardItem[],
  live: Map<string, TaskBoardItem>,
): TaskBoardItem[] {
  if (live.size === 0) return items;
  return items.map((item) => {
    const pushed = live.get(item.id);
    if (!pushed) return item;
    if (Date.parse(pushed.updatedAt) > Date.parse(item.updatedAt))
      return pushed;
    live.delete(item.id);
    return item;
  });
}

/**
 * The board's sprints, indexed by id, read from the same cached list the board
 * loads — so a card can name its sprint without the sprint being threaded down
 * through every lane and row.
 *
 * Shares `useTaskBoardItems`' query key and fetcher rather than calling that
 * hook itself: it also subscribes to the board's SSE streams, and one
 * subscription per rendered card is not what a lookup should cost.
 */
export function useBoardSprintIndex(): Map<string, Sprint> {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const { data } = useQuery({
    queryKey: KEYS.taskBoardItems(locator),
    queryFn: async (): Promise<TaskBoardData> => {
      const { items, sprints } = await studio.call("TASK_BOARD_ITEM_LIST", {});
      return { items: mergeLiveItems(items, liveItems), sprints };
    },
  });
  return new Map((data?.sprints ?? []).map((sprint) => [sprint.id, sprint]));
}

export function useTaskBoardItems() {
  const { org, locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const queryKey = KEYS.taskBoardItems(locator);

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<TaskBoardData> => {
      const { items, sprints } = await studio.call("TASK_BOARD_ITEM_LIST", {});
      return { items: mergeLiveItems(items, liveItems), sprints };
    },
    // Backstop for a stream that died without an error; paused when unfocused.
    refetchInterval: 60_000,
  });

  // Live Super Agent transitions (todo → in_progress → in_review). Upsert the
  // pushed item into the cached list so the board moves cards without polling.
  useTaskBoardEvents({
    orgSlug: org.slug,
    onUpdate: (item) => {
      liveItems.set(item.id, item);
      queryClient.setQueryData<TaskBoardData>(queryKey, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.some((t) => t.id === item.id)
            ? prev.items.map((t) => (t.id === item.id ? item : t))
            : [item, ...prev.items],
        };
      });
      // Every pushed item change also appends to its timeline — refetch the
      // activity feed so a task dialog left open during a live transition
      // (e.g. a Super Agent status/assignee change) doesn't show a stale one.
      queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardActivity(locator, item.id),
      });
    },
    // Stream back after a drop — nothing was buffered, so re-read the list.
    onResync: () => {
      queryClient.invalidateQueries({ queryKey });
    },
    // Live deletes: drop the removed card so it clears on every open board.
    onDelete: (id) => {
      liveItems.delete(id);
      queryClient.setQueryData<TaskBoardData>(queryKey, (prev) =>
        prev ? { ...prev, items: prev.items.filter((t) => t.id !== id) } : prev,
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
      queryClient.setQueryData<TaskBoardData>(queryKey, (prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((item) =>
                item.threads.some((t) => t.threadId === threadId)
                  ? {
                      ...item,
                      threads: item.threads.map((t) =>
                        t.threadId === threadId ? { ...t, status } : t,
                      ),
                    }
                  : item,
              ),
            }
          : prev,
      );
    },
  });

  return {
    items: query.data?.items ?? [],
    sprints: query.data?.sprints ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

export function useTaskBoardItemActions() {
  const { org, locator } = useProjectContext();
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
      const previous = queryClient.getQueryData<TaskBoardData>(queryKey);
      queryClient.setQueryData<TaskBoardData>(queryKey, (prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((item) =>
                item.id === input.id ? { ...item, ...input } : item,
              ),
            }
          : prev,
      );
      return { previous };
    },
    // A person marking done, not the agent's run finishing (task_run_completed).
    onSuccess: (_data, input) => {
      if (input.status === "done")
        track("task_marked_done", {
          organization_id: org.id,
          task_board_item_id: input.id,
        });
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
    // The dialog is already closed, so a rejection needs a toast + refetch.
    onError: (err: unknown) => {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t("taskBoard.taskBoard.deleteError"),
      );
      invalidate();
    },
  });

  // Bulk delete: one summary toast instead of one per card.
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

  // Re-run a task with the Super Agent. NOT an UPDATE with the same assignee:
  // that is a silent no-op, since the dispatch fires only on the TRANSITION to
  // super-agent. No optimistic patch — the tool decides the resulting lane and
  // which runs it superseded, so wait for the real answer rather than guessing.
  const rerun = useMutation({
    mutationFn: (input: ToolInput<"TASK_BOARD_ITEM_RERUN">) =>
      studio.call("TASK_BOARD_ITEM_RERUN", input),
    onSettled: (_data, _err, input) => {
      invalidate();
      queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardActivity(locator, input.id),
      });
    },
  });

  return { create, update, remove, removeMany, link, rerun };
}

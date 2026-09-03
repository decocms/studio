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
  /** The board's own columns. Studio's lanes for most orgs; an org that owns
   *  its board sends its own, which is why the client cannot assume the set. */
  columns: ToolOutput<"TASK_BOARD_ITEM_LIST">["columns"];
};

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
      const { items, sprints, columns } = await studio.call(
        "TASK_BOARD_ITEM_LIST",
        {},
      );
      return { items, sprints, columns };
    },
  });
  return new Map((data?.sprints ?? []).map((sprint) => [sprint.id, sprint]));
}

/**
 * The board's columns, read from the same cached list the board loads.
 *
 * Exists for the reason `useBoardSprintIndex` does: `useTaskBoardItems` also
 * opens the board's SSE subscriptions, and a dialog that only needs to know
 * which lanes this board HAS should not pay for a stream per render.
 */
export function useBoardColumns(): TaskBoardData["columns"] {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const { data } = useQuery({
    queryKey: KEYS.taskBoardItems(locator),
    queryFn: async (): Promise<TaskBoardData> => {
      const { items, sprints, columns } = await studio.call(
        "TASK_BOARD_ITEM_LIST",
        {},
      );
      return { items, sprints, columns };
    },
  });
  return data?.columns ?? [];
}

/** The board list, as options rather than a hook, so a second reader can share
 *  this query's CACHE without inheriting its live wiring. The org home reads it
 *  with `useSuspenseQuery` (it needs the answer before it can choose a layout);
 *  the board itself reads it below with the polling backstop and the SSE
 *  upserts. Same key, one request, two reading styles. */
export function taskBoardItemsQueryOptions(
  locator: ReturnType<typeof useProjectContext>["locator"],
  studio: ReturnType<typeof useStudioTools>,
) {
  return {
    queryKey: KEYS.taskBoardItems(locator),
    // Backstop for a stream that died without an error; paused when unfocused.
    refetchInterval: 60_000,
    queryFn: async (): Promise<TaskBoardData> => {
      const { items, sprints, columns } = await studio.call(
        "TASK_BOARD_ITEM_LIST",
        {},
      );
      return { items, sprints, columns };
    },
  };
}

/**
 * The live path for `KEYS.taskBoardItems` — SSE upserts and the linked-thread
 * status patch, both writing the shared cache and reading none of it. Query-less
 * on purpose, so every reader of that key mounts the same liveness: the board,
 * and the org/project feed that reads the key through `useSuspenseQuery`. The
 * watch connection is shared per org, so a second mount adds a handler, not a
 * second stream.
 */
export function useTaskBoardLiveSync(): void {
  const { org, locator } = useProjectContext();
  const queryClient = useQueryClient();
  const queryKey = KEYS.taskBoardItems(locator);

  // Live Super Agent transitions (todo → in_progress → in_review). Upsert the
  // pushed item into the cached list so the board moves cards without polling.
  useTaskBoardEvents({
    orgSlug: org.slug,
    onUpdate: (item) => {
      // A list refetch already in flight was issued BEFORE this push, so its
      // answer predates the transition below and would overwrite it. That is
      // the "click Auto fix, the card jumps to In Progress and falls back to
      // To Do until F5" bug: `TASK_BOARD_ITEM_UPDATE` returns with the card
      // still in `todo` (the run worker writes `in_progress` later, in
      // `advanceTaskBoardForRun`), the mutation invalidates on that response,
      // and the refetch lands after this push. Cancelling drops the stale
      // response; the query is left stale, so the 60s backstop re-syncs.
      queryClient.cancelQueries({ queryKey });
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
    // Live deletes: drop the removed card, canceling a stale in-flight refetch first (same race as onUpdate above).
    onDelete: (id) => {
      queryClient.cancelQueries({ queryKey });
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
      // Same race as onUpdate/onDelete above: cancel a stale in-flight refetch first.
      queryClient.cancelQueries({ queryKey });
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
}

export function useTaskBoardItems() {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const query = useQuery(taskBoardItemsQueryOptions(locator, studio));
  useTaskBoardLiveSync();

  return {
    items: query.data?.items ?? [],
    sprints: query.data?.sprints ?? [],
    columns: query.data?.columns ?? [],
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

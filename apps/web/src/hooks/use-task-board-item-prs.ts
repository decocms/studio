import { useProjectContext } from "@/sdk";
import type { TaskBoardItemPr } from "@/layouts/task-board/config";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useTaskBoardItemPrsEvents } from "./use-task-board-item-prs-events";
import {
  readCachedTaskPrs,
  writeCachedTaskPrs,
} from "@/lib/task-board-prs-cache";

/** Poll interval for a task's PRs while the dialog is open. The tool fetches
 *  live GitHub state — PR/checks status and the checks→QA hand-off it drives —
 *  so a periodic refresh keeps the review lane moving without a webhook. Kept at
 *  one minute to stay well within GitHub's rate limits, since every poll fans
 *  out to live GitHub PR + checks calls. The query is only active while the
 *  dialog (and thus this hook) is mounted. */
const PRS_POLL_INTERVAL_MS = 60_000;

/** While a card is still waiting on GitHub the server answers from the database
 *  and enriches in the background, so the fill-in is one short poll away, not a
 *  minute. */
const PRS_UNENRICHED_POLL_INTERVAL_MS = 2_000;

/** CI and a deploy preview settle on their own, with no webhook to say when, so
 *  a PR waiting on either polls faster than the idle minute. Bounded to an open
 *  dialog; the server answers from cache while it refreshes. */
const PRS_IN_FLIGHT_POLL_INTERVAL_MS = 10_000;

/** A card the server returned before GitHub answered: link fields only. `state`
 *  is null for a PR GitHub could not be read for too, which polls the same way
 *  — the right behavior either way. */
const isUnenriched = (pr: TaskBoardItemPr) => pr.state === null;

/** Mirrors `isCardNotReady` on the server, including its 10-minute bound on
 *  chasing a preview url that may never arrive. */
const PREVIEW_CHASE_MS = 10 * 60_000;
const isInFlight = (pr: TaskBoardItemPr) => {
  if (pr.state !== "open") return false;
  if (pr.checksStatus === "pending") return true;
  if (pr.previewUrl !== null) return false;
  const activeAt = pr.updatedAt ? Date.parse(pr.updatedAt) : Number.NaN;
  return Number.isFinite(activeAt) && Date.now() - activeAt < PREVIEW_CHASE_MS;
};

/**
 * A task's linked PRs, each with live state fetched from GitHub via the
 * `TASK_BOARD_ITEM_PRS_GET` tool. Enabled only when a task id is present
 * (the create modal has none). Live state (including CI checks) can change
 * while the dialog is open, so poll it.
 */
export function useTaskBoardItemPrs(itemId: string | undefined) {
  const { org, locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  // The webhook's push path: fresh cards land here as soon as GitHub reports
  // CI finished or the deploy bot commented, ahead of the poll below.
  useTaskBoardItemPrsEvents({
    orgSlug: org.slug,
    itemId,
    onPrs: (prs) => {
      queryClient.setQueryData(
        KEYS.taskBoardItemPrs(locator, itemId ?? ""),
        prs,
      );
    },
  });

  return useQuery({
    queryKey: KEYS.taskBoardItemPrs(locator, itemId ?? ""),
    enabled: !!itemId,
    refetchInterval: (query) => {
      const prs = query.state.data;
      if (prs?.some(isUnenriched)) return PRS_UNENRICHED_POLL_INTERVAL_MS;
      if (prs?.some(isInFlight)) return PRS_IN_FLIGHT_POLL_INTERVAL_MS;
      return PRS_POLL_INTERVAL_MS;
    },
    // Seeded from localStorage so a cold page load paints the last known cards
    // instead of a skeleton. `initialDataUpdatedAt` carries the real age, so
    // React Query treats the seed as already stale and refetches on mount — the
    // card shows a breathing border while it does (`isFetching` in PrCard).
    // Both are FUNCTIONS: React Query only calls them when the key has no
    // cached data, so the parse doesn't run on every render.
    initialData: () =>
      itemId
        ? ((readCachedTaskPrs(locator, itemId)?.data as
            | TaskBoardItemPr[]
            | undefined) ?? undefined)
        : undefined,
    initialDataUpdatedAt: () =>
      itemId ? readCachedTaskPrs(locator, itemId)?.updatedAt : undefined,
    queryFn: async () => {
      const { prs } = await studio.call("TASK_BOARD_ITEM_PRS_GET", {
        taskBoardItemId: itemId!,
      });
      writeCachedTaskPrs(locator, itemId!, prs);
      return prs;
    },
  });
}

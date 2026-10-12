/** The board's sprints (`TASK_BOARD_SPRINT_*`). */

import { useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { StudioToolInput as ToolInput } from "@decocms/shared/tools/tool-io";
import type { Sprint } from "@decocms/shared/sprints";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useT } from "@/i18n/use-t";
import { taskBoardSprintsWatchView } from "./watch-sse-pool";

const NO_SPRINTS: Sprint[] = [];

/** Every sprint of the org, in reading order (running → next → closed). */
export function useTaskBoardSprints(): Sprint[] {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const { data } = useQuery({
    queryKey: KEYS.taskBoardSprints(org.id),
    staleTime: 60_000,
    queryFn: async () =>
      (await studio.call("TASK_BOARD_SPRINT_LIST", {})).sprints,
  });
  return data ?? NO_SPRINTS;
}

/** Re-read sprints, and the cards a completion or a delete moved. */
function useInvalidateSprints() {
  const { org, locator } = useProjectContext();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardSprints(org.id),
      }),
      queryClient.invalidateQueries({
        queryKey: KEYS.taskBoardItems(locator),
      }),
    ]);
}

const noSnapshot = () => 0;

/** Refetch when any client or agent changes a sprint. Mount once per board. */
export function useTaskBoardSprintsLive() {
  const { org } = useProjectContext();
  const refetch = useInvalidateSprints();
  const subscribe = () =>
    taskBoardSprintsWatchView.subscribe(org.slug, refetch, refetch);
  useSyncExternalStore(subscribe, noSnapshot, noSnapshot);
}

export function useSprintActions() {
  const studio = useStudioTools();
  const invalidate = useInvalidateSprints();
  const t = useT();
  const onError = (err: unknown) =>
    toast.error(
      err instanceof Error && err.message
        ? err.message
        : t("taskBoard.sprints.actionError"),
    );

  const create = useMutation({
    mutationFn: (input: ToolInput<"TASK_BOARD_SPRINT_CREATE">) =>
      studio.call("TASK_BOARD_SPRINT_CREATE", input),
    onError,
    onSettled: invalidate,
  });
  const update = useMutation({
    mutationFn: (input: ToolInput<"TASK_BOARD_SPRINT_UPDATE">) =>
      studio.call("TASK_BOARD_SPRINT_UPDATE", input),
    onError,
    onSettled: invalidate,
  });
  const start = useMutation({
    mutationFn: (id: string) => studio.call("TASK_BOARD_SPRINT_START", { id }),
    onError,
    onSettled: invalidate,
  });
  const complete = useMutation({
    mutationFn: (input: ToolInput<"TASK_BOARD_SPRINT_COMPLETE">) =>
      studio.call("TASK_BOARD_SPRINT_COMPLETE", input),
    onError,
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => studio.call("TASK_BOARD_SPRINT_DELETE", { id }),
    onError,
    onSettled: invalidate,
  });

  return { create, update, start, complete, remove };
}

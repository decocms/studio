/** Org task board releases — fetched only when the releases toggle is on. */

import { useProjectContext } from "@/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import type {
  StudioToolInput as ToolInput,
  StudioToolOutput as ToolOutput,
} from "@decocms/shared/tools/tool-io";

export type TaskBoardRelease =
  ToolOutput<"TASK_BOARD_RELEASE_LIST">["releases"][number];

export function useTaskBoardReleases(enabled: boolean) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const query = useQuery({
    queryKey: KEYS.taskBoardReleases(locator),
    enabled,
    queryFn: async () =>
      (await studio.call("TASK_BOARD_RELEASE_LIST", {})).releases,
  });
  return { releases: query.data ?? [], isLoading: query.isLoading };
}

export function useTaskBoardReleaseActions() {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: KEYS.taskBoardReleases(locator),
    });
    // Creating/deleting a release (un)stamps tasks server-side.
    queryClient.invalidateQueries({
      queryKey: KEYS.taskBoardItems(locator),
    });
  };

  const create = useMutation({
    mutationFn: (input: ToolInput<"TASK_BOARD_RELEASE_CREATE">) =>
      studio.call("TASK_BOARD_RELEASE_CREATE", input),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      studio.call("TASK_BOARD_RELEASE_DELETE", { id }),
    onSuccess: invalidate,
  });

  return { create, remove };
}

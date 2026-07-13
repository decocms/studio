import { useProjectContext } from "@decocms/mesh-sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { useStudioTools } from "@/web/lib/studio-tools";
import type { ToolInput, ToolOutput } from "@/tools/io-types";

type TaskBoardItem = ToolOutput<"TASK_BOARD_ITEM_LIST">["items"][number];

export function useTaskBoardItems() {
  const { locator } = useProjectContext();
  const studio = useStudioTools();

  const query = useQuery({
    queryKey: KEYS.taskBoardItems(locator),
    queryFn: async () => (await studio.call("TASK_BOARD_ITEM_LIST", {})).items,
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
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => studio.call("TASK_BOARD_ITEM_DELETE", { id }),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}

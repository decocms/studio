import { useProjectContext } from "@decocms/mesh-sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { useStudioTools } from "@/web/lib/studio-tools";
import type { ToolInput, ToolOutput } from "@/tools/io-types";

type KanbanTask = ToolOutput<"KANBAN_TASK_LIST">["items"][number];

export function useKanbanTasks() {
  const { locator } = useProjectContext();
  const studio = useStudioTools();

  const query = useQuery({
    queryKey: KEYS.kanbanTasks(locator),
    queryFn: async () => (await studio.call("KANBAN_TASK_LIST", {})).items,
  });

  return {
    items: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

export function useKanbanTaskActions() {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const queryKey = KEYS.kanbanTasks(locator);

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const create = useMutation({
    mutationFn: (input: ToolInput<"KANBAN_TASK_CREATE">) =>
      studio.call("KANBAN_TASK_CREATE", input),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: (input: ToolInput<"KANBAN_TASK_UPDATE">) =>
      studio.call("KANBAN_TASK_UPDATE", input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<KanbanTask[]>(queryKey);
      queryClient.setQueryData<KanbanTask[]>(queryKey, (prev) =>
        prev?.map((task) =>
          task.id === input.id ? { ...task, ...input } : task,
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
    mutationFn: (id: string) => studio.call("KANBAN_TASK_DELETE", { id }),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}

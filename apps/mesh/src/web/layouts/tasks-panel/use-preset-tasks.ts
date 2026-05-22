/**
 * usePresetTasks
 *
 * Reads the org's visible preset task cards from the backend — display,
 * action, and per-card state. `dismiss` flips a card's state to "dismissed"
 * (optimistic). `startPreset` kicks the backend's decopilot run for a
 * preset and returns the freshly-minted taskId + the tile to pin; callers
 * owns the navigate side-effect; the BE auto-pins the matching tile on
 * the user's home board.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  StartPresetTaskResult,
  VisiblePresetTask,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";

export type { VisiblePresetTask } from "@decocms/mesh-sdk";

interface PresetTasksResponse {
  tasks: VisiblePresetTask[];
}

export function usePresetTasks(orgSlug: string) {
  const queryClient = useQueryClient();
  const queryKey = KEYS.presetTasks(orgSlug);

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<VisiblePresetTask[]> => {
      const res = await fetch(`/api/${orgSlug}/preset-tasks`);
      if (!res.ok) throw new Error("Failed to load preset tasks");
      const body = (await res.json()) as PresetTasksResponse;
      return body.tasks;
    },
    // Card visibility depends on world state outside the FE's control
    // (brand row created from Settings, GitHub installed via the picker,
    // etc.). Bypass the global 1-min staleTime so window focus always
    // re-fetches and the cards update without a hard reload.
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });

  const dismiss = useMutation({
    mutationFn: async (taskId: string) => {
      const res = await fetch(
        `/api/${orgSlug}/preset-tasks/${taskId}/dismiss`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error("Failed to dismiss preset task");
    },
    onMutate: async (taskId: string) => {
      // Optimistic: remove the dismissed card from the list immediately.
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<VisiblePresetTask[]>(queryKey);
      queryClient.setQueryData<VisiblePresetTask[]>(queryKey, (curr) =>
        (curr ?? []).map((t) =>
          t.id === taskId
            ? {
                ...t,
                state: {
                  ...(t.state ?? { status: "dismissed" }),
                  status: "dismissed",
                  dismissedAt: new Date().toISOString(),
                },
              }
            : t,
        ),
      );
      return { previous };
    },
    onError: (_err, _taskId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const start = useMutation({
    mutationFn: async (taskId: string): Promise<StartPresetTaskResult> => {
      const res = await fetch(`/api/${orgSlug}/preset-tasks/${taskId}/start`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Failed to start preset task");
      }
      return (await res.json()) as StartPresetTaskResult;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  return {
    isLoading: query.isLoading,
    tasks: query.data ?? [],
    dismiss: (taskId: string) => dismiss.mutate(taskId),
    startPreset: (taskId: string) => start.mutateAsync(taskId),
  };
}

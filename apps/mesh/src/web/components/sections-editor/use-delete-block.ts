import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { decoBlockFilePath } from "./deco-block-key";

interface UseDeleteBlockParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

/**
 * Delete a decofile block by removing its `.deco/blocks/<key>.json` file.
 * Optimistically removes the entry from the React Query cache; rolls back
 * on failure. Idempotent — a missing file returns `existed: false` and
 * is treated as success.
 */
export function useDeleteBlock({
  orgSlug,
  virtualMcpId,
  branch,
}: UseDeleteBlockParams) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ blockKey }: { blockKey: string }) => {
      const path = decoBlockFilePath(blockKey);
      const res = await fetch(
        `/api/${orgSlug}/sandbox/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/unlink`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Delete failed (${res.status})`,
        );
      }
      return res.json() as Promise<{ ok: true; existed: boolean }>;
    },
    onMutate: async ({ blockKey }) => {
      const cacheKey = `${orgSlug}/${virtualMcpId}/${branch}`;
      const queryKey = KEYS.decofile(cacheKey);
      await queryClient.cancelQueries({ queryKey });
      const previous =
        queryClient.getQueryData<Record<string, unknown>>(queryKey);
      queryClient.setQueryData(
        queryKey,
        (current: Record<string, unknown> | undefined) => {
          if (!current) return current;
          const { [blockKey]: _removed, ...rest } = current;
          return rest;
        },
      );
      return { previous, queryKey };
    },
    onError: (_error, _variables, context) => {
      if (context?.queryKey) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
    },
    onSuccess: () => {
      const cacheKey = `${orgSlug}/${virtualMcpId}/${branch}`;
      void queryClient.invalidateQueries({ queryKey: KEYS.liveMeta(cacheKey) });
    },
  });
}

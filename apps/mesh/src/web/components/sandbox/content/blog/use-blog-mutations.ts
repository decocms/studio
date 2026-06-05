/**
 * Save/delete hooks for blog collection blocks. These mirror the generic
 * `use-save-block`/`use-delete-block` hooks but encode the block id into
 * the on-disk filename (blog ids contain `/`, which the generic hooks
 * reject). The React Query cache stays keyed by the decoded block id, so
 * the rest of the Content tab reads blog blocks like any other entry.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { blogBlockFilePath } from "./blog-data";

interface BlogMutationParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

function decofileQueryKey({
  orgSlug,
  virtualMcpId,
  branch,
}: BlogMutationParams) {
  return KEYS.decofile(`${orgSlug}/${virtualMcpId}/${branch}`);
}

function writeUrl(
  { orgSlug, virtualMcpId, branch }: BlogMutationParams,
  op: "write" | "unlink",
) {
  return `/api/${orgSlug}/sandbox/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/${op}`;
}

export function useSaveBlogBlock(params: BlogMutationParams) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      blockKey,
      data,
    }: {
      blockKey: string;
      data: unknown;
    }) => {
      const res = await fetch(writeUrl(params, "write"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: blogBlockFilePath(blockKey),
          content: JSON.stringify(data, null, 2),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Write failed (${res.status})`,
        );
      }
      return res.json();
    },
    onMutate: async ({ blockKey, data }) => {
      const queryKey = decofileQueryKey(params);
      await queryClient.cancelQueries({ queryKey });
      const previous =
        queryClient.getQueryData<Record<string, unknown>>(queryKey);
      queryClient.setQueryData(
        queryKey,
        (current: Record<string, unknown> | undefined) => ({
          ...(current ?? {}),
          [blockKey]: data,
        }),
      );
      return { previous, queryKey };
    },
    onError: (_error, _variables, context) => {
      if (context?.queryKey) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
    },
  });
}

export function useDeleteBlogBlock(params: BlogMutationParams) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ blockKey }: { blockKey: string }) => {
      const res = await fetch(writeUrl(params, "unlink"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: blogBlockFilePath(blockKey) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Delete failed (${res.status})`,
        );
      }
      return res.json() as Promise<{ ok: true; existed: boolean }>;
    },
    onMutate: async ({ blockKey }) => {
      const queryKey = decofileQueryKey(params);
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
  });
}

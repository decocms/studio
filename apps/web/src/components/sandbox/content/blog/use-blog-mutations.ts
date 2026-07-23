/**
 * Save/delete hooks for blog collection blocks. These mirror the generic
 * `use-save-block`/`use-delete-block` hooks but encode the block id into
 * the on-disk filename (blog ids contain `/`, which the generic hooks
 * reject). The React Query cache stays keyed by the decoded block id, so
 * the rest of the Content tab reads blog blocks like any other entry.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { decoRepoPath } from "@/components/sections-editor/deco-repo-path";
import { blogBlockFilePath } from "./blog-data";

interface BlogMutationParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  /**
   * Project package path (`metadata.runtime.path`) to prefix onto the daemon
   * write path — the daemon resolves against the repo root. Resolve via
   * `usePackagePath` at the call site (keeps this hook free of ProjectContext).
   */
  packagePath?: string | null;
}

function decofileQueryKey({
  orgSlug,
  virtualMcpId,
  branch,
}: BlogMutationParams) {
  return KEYS.decofile(`${orgSlug}/${virtualMcpId}/${branch}`);
}

function liveMetaQueryKey({
  orgSlug,
  virtualMcpId,
  branch,
}: BlogMutationParams) {
  return KEYS.liveMeta(orgSlug, virtualMcpId, branch);
}

function writeUrl(
  { orgSlug, virtualMcpId, branch }: BlogMutationParams,
  op: "write" | "unlink",
) {
  return `/api/${orgSlug}/sandbox/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/${op}`;
}

async function postToSandbox(
  params: BlogMutationParams,
  op: "write" | "unlink",
  body: unknown,
  fallbackError: string,
) {
  const res = await fetch(writeUrl(params, op), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(
      (errBody as { error?: string }).error ??
        `${fallbackError} (${res.status})`,
    );
  }
  return res.json();
}

export function useSaveBlogBlock(params: BlogMutationParams) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ blockKey, data }: { blockKey: string; data: unknown }) =>
      postToSandbox(
        params,
        "write",
        {
          path: decoRepoPath(params.packagePath, blogBlockFilePath(blockKey)),
          content: JSON.stringify(data, null, 2),
        },
        "Write failed",
      ),
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
    mutationFn: ({ blockKey }: { blockKey: string }) =>
      postToSandbox(
        params,
        "unlink",
        { path: decoRepoPath(params.packagePath, blogBlockFilePath(blockKey)) },
        "Delete failed",
      ) as Promise<{ ok: true; existed: boolean }>,
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
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: liveMetaQueryKey(params),
      });
    },
  });
}

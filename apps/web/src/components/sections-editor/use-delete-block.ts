import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useVirtualMCP } from "@/sdk";
import { resolveFastPreview } from "@/sdk/fast-preview";
import { KEYS } from "@/lib/query-keys";
import { decoBlockFilePath } from "./deco-block-key";
import { decoRepoPath } from "./deco-repo-path";
import {
  decofileWriteMutationKey,
  patchDecofile,
  setDecofileDraft,
  throwResponseError,
} from "./decofile-api";
import { sandboxGitStatusQueryKey } from "../thread/github/sandbox-git-api";

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
  const vmcp = useVirtualMCP(virtualMcpId);
  // Under the project's package path (`metadata.runtime.path`) when the project
  // isn't at the repo root — the daemon resolves against the repo root.
  const packagePath = vmcp?.metadata?.runtime?.path ?? null;
  // Sandbox-less mode: deletes commit through the decofile API and remove every
  // encoding alias of the key server-side.
  const fastPreviewActive = resolveFastPreview(vmcp?.metadata).active;

  return useMutation({
    mutationKey: decofileWriteMutationKey(orgSlug, virtualMcpId, branch),
    mutationFn: async ({ blockKey }: { blockKey: string }) => {
      if (fastPreviewActive) {
        const draft = await patchDecofile(
          { orgSlug, virtualMcpId, branch },
          { delete: [blockKey] },
        );
        setDecofileDraft(queryClient, { orgSlug, virtualMcpId, branch }, draft);
        /**
         * Same as use-save-block: the commit moved the head, refresh the
         * header's branch meta in place of any interval polling — and await
         * it, so observers of this mutation aren't released onto a status
         * that is still the pre-delete one.
         */
        await queryClient.invalidateQueries({
          queryKey: sandboxGitStatusQueryKey(orgSlug, virtualMcpId, branch),
        });
        return { ok: true as const, existed: true };
      }
      const path = decoRepoPath(packagePath, decoBlockFilePath(blockKey));
      const res = await fetch(
        `/api/${orgSlug}/sandbox/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/unlink`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        },
      );
      if (!res.ok) return throwResponseError(res, "Delete");
      return res.json() as Promise<{ ok: true; existed: boolean }>;
    },
    onMutate: async ({ blockKey }) => {
      const cacheKey = `${orgSlug}/${virtualMcpId}/${branch}`;
      const queryKey = KEYS.decofile(cacheKey);
      await queryClient.cancelQueries({ queryKey });
      const previous =
        queryClient.getQueryData<Record<string, unknown>>(queryKey);
      const hadKey = !!previous && blockKey in previous;
      const previousValue = previous?.[blockKey];
      queryClient.setQueryData(
        queryKey,
        (current: Record<string, unknown> | undefined) => {
          if (!current) return current;
          const { [blockKey]: _removed, ...rest } = current;
          return rest;
        },
      );
      return { queryKey, blockKey, hadKey, previousValue };
    },
    // Restore only this mutation's own key so a concurrent sibling save isn't clobbered.
    onError: (_error, _variables, context) => {
      if (!context) return;
      queryClient.setQueryData(
        context.queryKey,
        (current: Record<string, unknown> | undefined) => {
          if (!context.hadKey) return current;
          return {
            ...(current ?? {}),
            [context.blockKey]: context.previousValue,
          };
        },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: KEYS.liveMeta(orgSlug, virtualMcpId, branch),
      });
    },
  });
}

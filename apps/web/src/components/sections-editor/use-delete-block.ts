import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { usePackagePath } from "./use-package-path";
import { KEYS } from "@/lib/query-keys";
import { decoBlockFilePath } from "./deco-block-key";
import { decoRepoPath } from "./deco-repo-path";
import {
  decofileWriteMutationKey,
  decofileWriteScope,
  patchDecofile,
  setDecofileDraft,
  throwResponseError,
} from "./decofile-api";
import { sandboxGitStatusQueryKey } from "../thread/repository/sandbox-git-api";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { useContentBackend } from "./use-content-backend";
import { applyProtocolPatch } from "./content-protocol-api";
import { applyHostedChange, HostedKeptTheirsError } from "./hosted-reconcile";
import { toastKeptTheirs } from "./site-editor-toast";
import { type KeptTheirVersion, keptTheirVersion } from "./use-save-block";
import { useT } from "@/i18n/use-t";
import { runContentChange } from "./content-sync";
import {
  HostedKeptChangingError,
  inPlainWords,
  isSaveConflict,
} from "./serve-save-error";
import { useDecofileCacheKey } from "./use-decofile";
import { buildSandboxUrl } from "@/sdk/sandbox-url";

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
  const threadId = useOptionalChatTask()?.taskId ?? null;
  // Prefixes the daemon path: the daemon resolves against the repo root.
  const packagePath = usePackagePath(virtualMcpId);
  // Sandbox-less mode: deletes commit through the decofile API and remove every
  // encoding alias of the key server-side.
  const fastPreviewActive = useSessionRuntime(virtualMcpId).runtime === "cms";
  /**
   * Local mode: nothing is persisted — the optimistic cache removal below IS
   * the whole delete, same as `useSaveBlock`. It also keys the cache, so
   * reading it without the tunnel patched a decofile nobody is rendering.
   */
  const { url: localPreviewUrl } = useLocalPreviewUrl(virtualMcpId);
  const backend = useContentBackend(virtualMcpId, branch);
  const protocol = backend.kind === "protocol" ? backend : null;
  const cacheKey = useDecofileCacheKey({ orgSlug, virtualMcpId, branch });

  /** A delete on any backend but the content protocol. */
  const deleteLegacy = async (
    blockKey: string,
  ): Promise<{ ok: true; existed: boolean }> => {
    // Local: no persistence — the optimistic cache removal is the delete.
    if (localPreviewUrl) return { ok: true as const, existed: true };
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
        queryKey: sandboxGitStatusQueryKey({
          orgSlug,
          virtualMcpId,
          branch,
          threadId,
        }),
      });
      return { ok: true as const, existed: true };
    }
    const path = decoRepoPath(packagePath, decoBlockFilePath(blockKey));
    const res = await fetch(
      buildSandboxUrl({ orgSlug, virtualMcpId, branch, threadId }, "unlink"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      },
    );
    if (!res.ok) return throwResponseError(res, "Delete");
    return res.json() as Promise<{ ok: true; existed: boolean }>;
  };

  const t = useT();
  const mutation = useMutation({
    mutationKey: decofileWriteMutationKey(orgSlug, virtualMcpId, branch),
    scope: decofileWriteScope(orgSlug, virtualMcpId, branch),
    mutationFn: async ({
      blockKey,
      base,
    }: DeleteBlockVariables): Promise<
      { ok: true; existed: boolean } | KeptTheirVersion
    > => {
      // Hosted v8: guarded by the draft's version of the block; someone
      // else's change meanwhile asks "Delete anyway" / "Keep their version"
      // (hosted-reconcile.ts). A block the draft already deletes is done.
      if (protocol?.source === "github") {
        try {
          await applyHostedChange(
            {
              queryClient,
              backend: protocol,
              params: { orgSlug, virtualMcpId, branch },
              cacheKey,
            },
            { writes: {}, deletes: [blockKey] },
            base && base.value !== undefined
              ? { [blockKey]: base.value }
              : undefined,
          );
        } catch (error) {
          if (error instanceof HostedKeptTheirsError) {
            return { keptTheirs: true, deleted: false };
          }
          throw error;
        }
        return { ok: true as const, existed: true };
      }
      if (protocol) {
        await applyProtocolPatch(
          queryClient,
          protocol,
          { orgSlug, virtualMcpId, branch },
          cacheKey,
          { delete: [blockKey] },
        );
        return { ok: true as const, existed: true };
      }
      // Every other backend: the same pending state, with its own refresh.
      return runContentChange(
        { queryClient, orgSlug, virtualMcpId, branch, backend, cacheKey },
        { kind: "edit", write: () => deleteLegacy(blockKey) },
      );
    },
    onMutate: async ({ blockKey }) => {
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
    onError: (error, _variables, context) => {
      // A hosted dead end says what to do, wherever its message shows.
      inPlainWords(t, error);
      if (!context) return;
      // A refused hosted delete put the draft's copy in the cache already.
      if (
        protocol?.source === "github" &&
        (isSaveConflict(error) || error instanceof HostedKeptChangingError)
      ) {
        return;
      }
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
    onSuccess: (result) => {
      // The user kept their version (the cache holds it): one calm toast.
      if (keptTheirVersion(result)) {
        toastKeptTheirs(t, false);
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: KEYS.liveMeta(orgSlug, virtualMcpId, branch),
      });
    },
  });

  /** The copy the delete was asked on, for the reconcile flow's question. */
  const withBase = (variables: DeleteBlockVariables): DeleteBlockVariables => {
    if (variables.base) return variables;
    const cached = queryClient.getQueryData<Record<string, unknown>>(
      KEYS.decofile(cacheKey),
    );
    return cached
      ? { ...variables, base: { value: cached[variables.blockKey] } }
      : variables;
  };

  return {
    ...mutation,
    mutate: (
      variables: DeleteBlockVariables,
      options?: Parameters<typeof mutation.mutate>[1],
    ) => mutation.mutate(withBase(variables), options),
    mutateAsync: (
      variables: DeleteBlockVariables,
      options?: Parameters<typeof mutation.mutateAsync>[1],
    ) => mutation.mutateAsync(withBase(variables), options),
  };
}

interface DeleteBlockVariables {
  blockKey: string;
  /** The block as the editor showed it when deleted (taken from the cache). */
  base?: { value: unknown };
}

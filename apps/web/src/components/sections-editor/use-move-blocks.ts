import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { usePackagePath } from "./use-package-path";
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
import { useOptionalChatTask } from "@/components/chat/chat-context";

interface UseMoveBlocksParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

/** Blocks to write and keys to drop, applied as one transition. */
export interface BlockMove {
  writes: Record<string, unknown>;
  deletes: string[];
}

/**
 * Move a record between block keys — write the new form and drop the old one
 * as a SINGLE transition.
 *
 * `useSaveBlock` + `useDeleteBlock` in sequence would work, but between the two
 * awaits both keys exist: a list that reads the decofile renders the record
 * twice, and a failed delete leaves that duplicate committed with nothing to
 * roll it back.
 *
 * The returned `move` patches the cache SYNCHRONOUSLY before dispatching,
 * rather than from `onMutate`. A caller that follows the record to its new key
 * — an open editor, say — re-points in the same tick, so no render ever sees
 * the old key already gone and the new one not yet there.
 *
 * Sandbox mode still needs one request per file — the daemon has no batch
 * endpoint — but they run inside this single mutation, so the cache is never
 * half-moved.
 */
export function useMoveBlocks({
  orgSlug,
  virtualMcpId,
  branch,
}: UseMoveBlocksParams) {
  const queryClient = useQueryClient();
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const packagePath = usePackagePath(virtualMcpId);
  const fastPreviewActive = useSessionRuntime(virtualMcpId).runtime === "cms";
  const queryKey = KEYS.decofile(`${orgSlug}/${virtualMcpId}/${branch}`);

  const mutation = useMutation({
    mutationKey: decofileWriteMutationKey(orgSlug, virtualMcpId, branch),
    mutationFn: async ({ writes, deletes }: BlockMove) => {
      if (fastPreviewActive) {
        // One PATCH, one commit — the server applies set and delete together.
        const draft = await patchDecofile(
          { orgSlug, virtualMcpId, branch },
          { set: writes, delete: deletes },
        );
        setDecofileDraft(queryClient, { orgSlug, virtualMcpId, branch }, draft);
        // Awaited like useSaveBlock: observers must not see a pre-move status.
        await queryClient.invalidateQueries({
          queryKey: sandboxGitStatusQueryKey({
            orgSlug,
            virtualMcpId,
            branch,
            threadId,
          }),
        });
        return draft;
      }
      const base = `/api/${orgSlug}/sandbox/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}`;
      // Write before unlink: a failure between them leaves the old key, not neither.
      for (const [blockKey, data] of Object.entries(writes)) {
        const res = await fetch(`${base}/write`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: decoRepoPath(packagePath, decoBlockFilePath(blockKey)),
            content: JSON.stringify(data, null, 2),
          }),
        });
        if (!res.ok) return throwResponseError(res, "Write");
      }
      for (const blockKey of deletes) {
        const res = await fetch(`${base}/unlink`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: decoRepoPath(packagePath, decoBlockFilePath(blockKey)),
          }),
        });
        if (!res.ok) return throwResponseError(res, "Delete");
      }
      return { ok: true as const };
    },
    onSuccess: () => {
      // The move changed which blocks resolve, so the schema must be re-read.
      void queryClient.invalidateQueries({
        queryKey: KEYS.liveMeta(orgSlug, virtualMcpId, branch),
      });
    },
  });

  /**
   * Apply `plan` to the cache now, then persist it. Rejects — after restoring
   * the cache — when the write fails, so a caller that re-pointed itself in the
   * same tick can undo that too.
   */
  const move = async (plan: BlockMove) => {
    // Snapshot only the touched keys, so a rollback can't revert a sibling write.
    const touched = [...Object.keys(plan.writes), ...plan.deletes];
    const previous =
      queryClient.getQueryData<Record<string, unknown>>(queryKey);
    const before = new Map<string, unknown>();
    for (const key of touched) {
      if (previous && key in previous) before.set(key, previous[key]);
    }
    queryClient.setQueryData(queryKey, (current) =>
      applyMoveToDecofile(current as Record<string, unknown> | undefined, plan),
    );
    // Unawaited: awaiting would put the patch a tick after the caller's own state change.
    void queryClient.cancelQueries({ queryKey });
    try {
      return await mutation.mutateAsync(plan);
    } catch (error) {
      queryClient.setQueryData(
        queryKey,
        (current: Record<string, unknown> | undefined) => {
          if (!current) return current;
          const next = { ...current };
          for (const key of touched) {
            if (before.has(key)) next[key] = before.get(key);
            else delete next[key];
          }
          return next;
        },
      );
      throw error;
    }
  };

  return { move, isPending: mutation.isPending };
}

/** Apply a move to a decofile snapshot. Pure — exported for its unit test. */
export function applyMoveToDecofile(
  current: Record<string, unknown> | undefined,
  { writes, deletes }: BlockMove,
): Record<string, unknown> {
  const next = { ...(current ?? {}), ...writes };
  for (const key of deletes) {
    // A key also being written is the move's target, not a casualty of it.
    if (key in writes) continue;
    delete next[key];
  }
  return next;
}

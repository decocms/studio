import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { usePackagePath } from "./use-package-path";
import { toast } from "sonner";
import { decoBlockFilePath } from "./deco-block-key";
import { decoRepoPath } from "./deco-repo-path";
import {
  decofileWriteMutationKey,
  type DecofileDraft,
  patchDecofile,
  setDecofileDraft,
  throwResponseError,
} from "./decofile-api";
import { sandboxGitStatusQueryKey } from "../thread/github/sandbox-git-api";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t";
import { BlockSaveRevisionTracker } from "./block-save-revision";
import { DebouncedSaveQueue } from "./debounced-save-queue";

/** Debounce window for form-driven block autosaves (ms). */
export const AUTOSAVE_DELAY = 700;

interface UseSaveBlockParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

const revisionTrackers = new WeakMap<object, BlockSaveRevisionTracker>();

function revisionTrackerFor(queryClient: object): BlockSaveRevisionTracker {
  let tracker = revisionTrackers.get(queryClient);
  if (!tracker) {
    tracker = new BlockSaveRevisionTracker();
    revisionTrackers.set(queryClient, tracker);
  }
  return tracker;
}

function saveMutationScopeKey({
  orgSlug,
  virtualMcpId,
  branch,
}: UseSaveBlockParams): string {
  return JSON.stringify(["decofile-save", orgSlug, virtualMcpId, branch]);
}

export function useSaveBlock({
  orgSlug,
  virtualMcpId,
  branch,
}: UseSaveBlockParams) {
  const queryClient = useQueryClient();
  const threadId = useOptionalChatTask()?.taskId ?? null;
  // Prefixes the daemon path: the daemon resolves against the repo root.
  const packagePath = usePackagePath(virtualMcpId);
  // Sandbox-less mode: writes go through the decofile API (a coalesced commit
  // on the branch) instead of the sandbox working tree. The server owns the
  // key -> file mapping, so no path construction here.
  const fastPreviewActive = useSessionRuntime(virtualMcpId).runtime === "cms";
  const mutationScopeKey = saveMutationScopeKey({
    orgSlug,
    virtualMcpId,
    branch,
  });
  const revisionTracker = revisionTrackerFor(queryClient);

  return useMutation({
    mutationKey: decofileWriteMutationKey(orgSlug, virtualMcpId, branch),
    // React Query registers later optimistic revisions immediately, but starts
    // their network writes serially. This gives every renderer/hook instance
    // for the same branch one authoritative server-write order.
    scope: { id: mutationScopeKey },
    mutationFn: async ({
      blockKey,
      data,
    }: {
      blockKey: string;
      data: unknown;
    }): Promise<DecofileDraft | null> => {
      if (fastPreviewActive) {
        const draft = await patchDecofile(
          { orgSlug, virtualMcpId, branch },
          { set: { [blockKey]: data } },
        );
        /**
         * The landed commit moved the branch head — refresh the header's
         * branch meta now. This write is the ONLY in-app head mutation, which
         * is what lets the status query drop interval polling entirely.
         *
         * Awaited, not fired and forgotten: observers key "is a save in
         * flight" off this mutation, and releasing them before the re-read
         * lands renders the PREVIOUS status as if it were current — a clean
         * "Up to date" over an edit that already exists.
         */
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
      const path = decoRepoPath(packagePath, decoBlockFilePath(blockKey));
      const content = JSON.stringify(data, null, 2);
      const res = await fetch(
        `/api/${orgSlug}/sandbox/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/write`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, content }),
        },
      );
      if (!res.ok) return throwResponseError(res, "Write");
      await res.json();
      return null;
    },
    onMutate: async ({ blockKey, data }) => {
      const cacheKey = `${orgSlug}/${virtualMcpId}/${branch}`;
      const queryKey = KEYS.decofile(cacheKey);
      const previous =
        queryClient.getQueryData<Record<string, unknown>>(queryKey);
      const baseline = {
        exists: !!previous && blockKey in previous,
        value: previous?.[blockKey],
      };
      const revision = revisionTracker.begin(
        `${mutationScopeKey}:${JSON.stringify(blockKey)}`,
        baseline,
      );
      await queryClient.cancelQueries({ queryKey });
      if (!revisionTracker.isLatest(revision)) {
        return { queryKey, blockKey, revision };
      }
      queryClient.setQueryData(
        queryKey,
        (current: Record<string, unknown> | undefined) => ({
          ...(current ?? {}),
          [blockKey]: data,
        }),
      );
      return { queryKey, blockKey, revision };
    },
    // Older optimistic revisions never overwrite a newer one. If the newest
    // fails, restore the latest value that really reached the server rather
    // than a failed predecessor's optimistic snapshot.
    onError: (_error, _variables, context) => {
      if (!context) return;
      const rollback = revisionTracker.rollbackFor(context.revision);
      if (!rollback) return;
      queryClient.setQueryData(
        context.queryKey,
        (current: Record<string, unknown> | undefined) => {
          if (!rollback.exists) {
            if (!current) return current;
            const { [context.blockKey]: _removed, ...rest } = current;
            return rest;
          }
          return { ...current, [context.blockKey]: rollback.value };
        },
      );
    },
    onSuccess: (draft, { blockKey, data }, context) => {
      // Scope serialization means successful server writes settle in the exact
      // order in which they moved this branch head. Publish every successful
      // draft in that order, independent of the per-block optimistic fence.
      // A later failed write publishes nothing, so the last committed head
      // remains visible even when different blocks are interleaved.
      if (draft) {
        setDecofileDraft(queryClient, { orgSlug, virtualMcpId, branch }, draft);
      }
      if (
        !context ||
        !revisionTracker.recordSuccess(context.revision, {
          exists: true,
          value: data,
        })
      ) {
        return;
      }
      const cacheKey = `${orgSlug}/${virtualMcpId}/${branch}`;
      queryClient.setQueryData(
        KEYS.decofile(cacheKey),
        (current: Record<string, unknown> | undefined) => ({
          ...(current ?? {}),
          [blockKey]: data,
        }),
      );
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context) revisionTracker.settle(context.revision);
    },
  });
}

/**
 * The payload for a debounced save: either a ready object, or a builder
 * resolved at fire time. Pass a builder when the block is also written by
 * another debounced path (e.g. a page's name/path edits vs. its SEO edits) so
 * the persisted value is a read-modify-write against the freshest block data
 * instead of a stale keystroke-time snapshot — otherwise the later-firing save
 * clobbers the other path's concurrent edit.
 */
type SaveData =
  | Record<string, unknown>
  | (() => Record<string, unknown> | null);

interface DebouncedSaveBlockOptions {
  onSaved?: () => void;
}

/**
 * Wraps {@link useSaveBlock} with the standard debounced-autosave loop shared by
 * every form-driven block editor (section forms, the SEO editor, the SEO
 * sheets). Call `save(blockKey, data)` on each change; the latest payload is
 * persisted once edits settle for {@link AUTOSAVE_DELAY}ms, with a toast on
 * failure. `data` may be a builder (see {@link SaveData}) that returns null to
 * abort the save.
 */
export function useDebouncedSaveBlock(
  params: UseSaveBlockParams,
  opts?: DebouncedSaveBlockOptions,
) {
  const saveBlock = useSaveBlock(params);
  const t = useT();
  const runtimeRef = useRef({
    mutate: saveBlock.mutate,
    onSaved: opts?.onSaved,
    scopeKey: saveMutationScopeKey(params),
    t,
  });
  // Old Monaco callbacks and PageJsonPanel's intentionally stable ref-cleanup
  // may retain the first `save`/`flush` closure. All work they enqueue reads
  // this current runtime, while already-pending work keeps the scope it was
  // created for so a branch change can never redirect it.
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- latest runtime mirror for stable editor/ref callbacks
  runtimeRef.current = {
    mutate: saveBlock.mutate,
    onSaved: opts?.onSaved,
    scopeKey: saveMutationScopeKey(params),
    t,
  };

  interface PendingSave {
    blockKey: string;
    data: SaveData;
    runtime: typeof runtimeRef.current;
  }

  const consumePendingSave = (pending: PendingSave) => {
    try {
      const resolved =
        typeof pending.data === "function" ? pending.data() : pending.data;
      if (!resolved) return;
      pending.runtime.mutate(
        { blockKey: pending.blockKey, data: resolved },
        {
          onSuccess: () => pending.runtime.onSaved?.(),
          onError: (err) =>
            toast.error(
              pending.runtime.t("sectionsEditor.sectionsEditor.saveFailed", {
                error: err.message,
              }),
            ),
        },
      );
    } catch (error) {
      toast.error(
        pending.runtime.t("sectionsEditor.sectionsEditor.saveFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  const [saveQueue] = useState(
    () => new DebouncedSaveQueue<PendingSave>(consumePendingSave),
  );

  const flush = () => saveQueue.flush();
  /** Explicitly abandon values that have not entered the mutation queue yet. */
  const discard = () => saveQueue.discard();

  // Route changes are ordinary completion, not cancellation: persist the last
  // valid value synchronously during teardown. A caller that implements a real
  // Cancel action can call `discard()` immediately before teardown.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — timer lifecycle cleanup on unmount
  useEffect(() => {
    return () => saveQueue.settleOnUnmount();
  }, [saveQueue]);

  const save = (blockKey: string, data: SaveData) => {
    const runtime = runtimeRef.current;
    const pendingKey = `${runtime.scopeKey}:${JSON.stringify(blockKey)}`;
    saveQueue.schedule(pendingKey, { blockKey, data, runtime }, AUTOSAVE_DELAY);
  };

  return { save, flush, discard, isPending: saveBlock.isPending };
}

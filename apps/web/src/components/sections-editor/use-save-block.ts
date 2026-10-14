import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { decofileCacheKey } from "./use-decofile";
import { usePackagePath } from "./use-package-path";
import { toast } from "sonner";
import {
  decoBlockFingerprint,
  sanitizeSecretsForPersistence,
} from "@decocms/shared/decofile";
import { decoBlockFilePath } from "./deco-block-key";
import { decoRepoPath } from "./deco-repo-path";
import {
  BlockConflictError,
  decofileWriteMutationKey,
  decofileWriteScope,
  patchDecofile,
  setDecofileDraft,
  throwResponseError,
} from "./decofile-api";
import { sandboxGitStatusQueryKey } from "../thread/repository/sandbox-git-api";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { buildSandboxUrl } from "@/sdk/sandbox-url";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t";

/** Debounce window for form-driven block autosaves (ms). */
export const AUTOSAVE_DELAY = 700;

interface UseSaveBlockParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

/** The block a write was built from; `value: undefined` when there was none. */
interface SaveBlockBase {
  value: unknown;
}

interface SaveBlockVariables {
  blockKey: string;
  data: unknown;
  /**
   * Every save replaces the whole block, so the server refuses one built from
   * a version the branch no longer has (another draft published, a sync moved
   * the branch) rather than reverting those changes. Defaults to the cached
   * block at call time, which is right for writes derived from the cache. An
   * editor that holds its own copy, like an open form, must pass the copy it
   * started from.
   */
  base?: SaveBlockBase;
}

async function blockExpectation(
  blockKey: string,
  base: SaveBlockBase | undefined,
): Promise<Record<string, string | null> | undefined> {
  if (!base) return undefined;
  if (base.value === undefined) return { [blockKey]: null };
  try {
    return { [blockKey]: await decoBlockFingerprint(base.value) };
  } catch {
    // A base that could never be persisted has no version to compare against.
    return undefined;
  }
}

export function useSaveBlock({
  orgSlug,
  virtualMcpId,
  branch,
}: UseSaveBlockParams) {
  const queryClient = useQueryClient();
  const t = useT();
  const threadId = useOptionalChatTask()?.taskId ?? null;
  // Prefixes the daemon path: the daemon resolves against the repo root.
  const packagePath = usePackagePath(virtualMcpId);
  // Sandbox-less mode: writes go through the decofile API (a coalesced commit
  // on the branch) instead of the sandbox working tree. The server owns the
  // key -> file mapping, so no path construction here.
  const fastPreviewActive = useSessionRuntime(virtualMcpId).runtime === "cms";
  /**
   * Local mode: edits are fake/ephemeral — the optimistic cache write below IS
   * the whole save (no daemon, no commit), so it lives only until reload. The
   * in-place render picks the merged decofile up and repaints the tunnel frame.
   */
  const { url: localPreviewUrl } = useLocalPreviewUrl(virtualMcpId);
  const cacheKey = decofileCacheKey({
    orgSlug,
    virtualMcpId,
    branch,
    localPreviewUrl,
  });

  const mutation = useMutation({
    mutationKey: decofileWriteMutationKey(orgSlug, virtualMcpId, branch),
    // Serialize a branch's writes so overlapping autosaves can't land an older payload last, dropping a newer edit.
    scope: decofileWriteScope(orgSlug, virtualMcpId, branch),
    mutationFn: async ({ blockKey, data, base }: SaveBlockVariables) => {
      // Fail closed before any write path: a raw secret must never be persisted.
      data = sanitizeSecretsForPersistence(data);
      // Local: no persistence — the optimistic cache write is the save.
      if (localPreviewUrl) return { blockKey, data };
      if (fastPreviewActive) {
        const expect = await blockExpectation(blockKey, base);
        let draft;
        try {
          draft = await patchDecofile(
            { orgSlug, virtualMcpId, branch },
            { set: { [blockKey]: data }, ...(expect ? { expect } : {}) },
          );
        } catch (err) {
          if (!(err instanceof BlockConflictError)) throw err;
          // Re-read before failing, so whatever reacts to the error sees the
          // branch's current copy rather than the one this edit was built on.
          await queryClient.invalidateQueries({
            queryKey: KEYS.decofile(cacheKey),
          });
          throw new BlockConflictError(
            err.blocks,
            t("sectionsEditor.sectionsEditor.blockChangedElsewhere"),
          );
        }
        setDecofileDraft(queryClient, { orgSlug, virtualMcpId, branch }, draft);
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
        buildSandboxUrl({ orgSlug, virtualMcpId, branch, threadId }, "write"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, content }),
        },
      );
      if (!res.ok) return throwResponseError(res, "Write");
      return res.json();
    },
    onMutate: async ({ blockKey, data }) => {
      const queryKey = KEYS.decofile(cacheKey);
      await queryClient.cancelQueries({ queryKey });
      const previous =
        queryClient.getQueryData<Record<string, unknown>>(queryKey);
      const hadKey = !!previous && blockKey in previous;
      const previousValue = previous?.[blockKey];
      queryClient.setQueryData(
        queryKey,
        (current: Record<string, unknown> | undefined) => ({
          ...(current ?? {}),
          [blockKey]: data,
        }),
      );
      return { queryKey, blockKey, hadKey, previousValue };
    },
    // Restore only this mutation's own key so a concurrent sibling save isn't clobbered.
    // A conflict already re-read the block; restoring would put the stale copy back.
    onError: (error, _variables, context) => {
      if (!context || error instanceof BlockConflictError) return;
      queryClient.setQueryData(
        context.queryKey,
        (current: Record<string, unknown> | undefined) => {
          if (!current) return current;
          if (!context.hadKey) {
            const { [context.blockKey]: _removed, ...rest } = current;
            return rest;
          }
          return { ...current, [context.blockKey]: context.previousValue };
        },
      );
    },
    onSuccess: (_result, { blockKey, data }) => {
      queryClient.setQueryData(
        KEYS.decofile(cacheKey),
        (current: Record<string, unknown> | undefined) => ({
          ...(current ?? {}),
          [blockKey]: data,
        }),
      );
    },
  });

  const withBase = (variables: SaveBlockVariables): SaveBlockVariables => {
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
      variables: SaveBlockVariables,
      options?: Parameters<typeof mutation.mutate>[1],
    ) => mutation.mutate(withBase(variables), options),
    mutateAsync: (
      variables: SaveBlockVariables,
      options?: Parameters<typeof mutation.mutateAsync>[1],
    ) => mutation.mutateAsync(withBase(variables), options),
  };
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
  opts?: { onSaved?: () => void },
) {
  const saveBlock = useSaveBlock(params);
  const t = useT();
  const pendingRef = useRef<Map<string, SaveData>>(new Map());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const runPendingSave = (blockKey: string) => {
    const pending = pendingRef.current.get(blockKey);
    if (!pending) return;
    const resolved = typeof pending === "function" ? pending() : pending;
    pendingRef.current.delete(blockKey);
    if (!resolved) return;
    saveBlock.mutate(
      { blockKey, data: resolved },
      {
        onSuccess: () => opts?.onSaved?.(),
        onError: (err) =>
          toast.error(
            t("sectionsEditor.sectionsEditor.saveFailed", {
              error: err.message,
            }),
          ),
      },
    );
  };

  const flush = () => {
    for (const timer of timersRef.current.values()) {
      clearTimeout(timer);
    }
    timersRef.current.clear();
    for (const blockKey of [...pendingRef.current.keys()]) {
      runPendingSave(blockKey);
    }
  };

  // Cancel pending debounced saves on unmount so they can't fire against a torn
  // -down editor after navigation. Call `flush()` explicitly when closing a sheet
  // or leaving an editor so edits inside the debounce window still persist.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — timer lifecycle cleanup on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  const save = (blockKey: string, data: SaveData) => {
    pendingRef.current.set(blockKey, data);
    const existing = timersRef.current.get(blockKey);
    if (existing) clearTimeout(existing);
    timersRef.current.set(
      blockKey,
      setTimeout(() => {
        timersRef.current.delete(blockKey);
        runPendingSave(blockKey);
      }, AUTOSAVE_DELAY),
    );
  };

  return { save, flush, isPending: saveBlock.isPending };
}

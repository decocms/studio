import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { useDecofileCacheKey } from "./use-decofile";
import { useContentBackend } from "./use-content-backend";
import {
  applyProtocolPatch,
  reloadProtocolBlock,
} from "./content-protocol-api";
import { runContentChange, useContentDiscardListener } from "./content-sync";
import { usePackagePath } from "./use-package-path";
import {
  decoBlockFingerprint,
  mergeBlockJson,
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
import { isSaveConflict } from "./serve-save-error";
import { toastSaveError } from "./site-editor-toast";
import { describeConflictFields } from "./conflict-fields";

/** Debounce window for form-driven block autosaves (ms). */
export const AUTOSAVE_DELAY = 700;

interface UseSaveBlockParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

/**
 * A `blocks.apply` version guard for one save, decided when the save runs
 * (saves of a branch run one at a time), not when it's scheduled. `ifMatch`
 * returns the guard, or undefined for none; `onApplied` runs as soon as the
 * guarded write lands, before the next save of the branch starts. Only the
 * content-protocol backend sends it; the others have no versions.
 */
export interface SaveGuard {
  ifMatch: (blockKey: string) => Record<string, string | null> | undefined;
  /** `versions`: what `blocks.apply` answered, each written block's new version. */
  onApplied?: (versions: Record<string, string | null>) => void;
  /** A save the guard refused (or any failed guarded save): re-read the content. */
  onRejected?: (error: unknown) => void;
  /**
   * A refused save means the editor's copy was outdated, as a legacy 409
   * `block-conflict`: the save reads the block again, keeps what is stored
   * (no optimistic rollback) and fails with a {@link BlockConflictError},
   * which the section form handles the same way on every backend.
   */
  reloadOnConflict?: boolean;
}

/** The block a write was built from; `value: undefined` when there was none. */
interface SaveBlockBase {
  value: unknown;
  /** Taken from the cache by default rather than handed in by the caller. */
  fromCache?: boolean;
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
   *
   * When the server refuses a write built from the cache, the save re-reads
   * the block and replays this edit on top of it, as long as the two changed
   * different values; otherwise it fails naming the values both changed. A
   * caller that resolves conflicts itself turns that off with
   * `rebaseOnConflict: false`.
   */
  base?: SaveBlockBase;
  rebaseOnConflict?: boolean;
  /** The content protocol's version guard (Studio's v8 backends only). */
  guard?: SaveGuard;
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
  // Next-major Blocks sites: one `blocks.apply` per save.
  const backend = useContentBackend(virtualMcpId, branch);
  const protocol = backend.kind === "protocol" ? backend : null;
  const cacheKey = useDecofileCacheKey({ orgSlug, virtualMcpId, branch });
  const t = useT();

  /**
   * A save on any backend but the content protocol. On Fast Preview it sends
   * the version the edit was built from (`base`), and a write the server
   * refuses as stale is replayed once on the stored block when the two edits
   * changed different values (see {@link SaveBlockVariables}).
   */
  const writeLegacy = async (
    blockKey: string,
    data: unknown,
    base: SaveBlockBase | undefined,
    rebaseOnConflict: boolean,
  ) => {
    // Local: no persistence — the optimistic cache write is the save.
    if (localPreviewUrl) return { blockKey, data };
    if (fastPreviewActive) {
      const write = async (value: unknown, from: SaveBlockBase | undefined) => {
        const expect = await blockExpectation(blockKey, from);
        return patchDecofile(
          { orgSlug, virtualMcpId, branch },
          { set: { [blockKey]: value }, ...(expect ? { expect } : {}) },
        );
      };
      let written = data;
      let draft;
      try {
        draft = await write(data, base);
      } catch (err) {
        if (!(err instanceof BlockConflictError)) throw err;
        // Re-read before anything else, so whatever reacts to the outcome
        // sees the branch's current copy rather than the one this edit was
        // built on.
        await queryClient.invalidateQueries({
          queryKey: KEYS.decofile(cacheKey),
        });
        const stored = queryClient.getQueryData<Record<string, unknown>>(
          KEYS.decofile(cacheKey),
        )?.[blockKey];
        const fields: string[] = [];
        const rebased =
          rebaseOnConflict && base?.fromCache
            ? mergeBlockJson(base.value, data, stored, {
                prefer: "theirs",
                conflicts: fields,
              })
            : undefined;
        if (rebased === undefined || fields.length > 0) {
          throw new BlockConflictError(
            err.blocks,
            fields.length > 0
              ? t("sectionsEditor.sectionsEditor.blockFieldsChangedElsewhere", {
                  fields: describeConflictFields(fields),
                })
              : t("sectionsEditor.sectionsEditor.blockChangedElsewhere"),
            fields,
          );
        }
        // The two edits touched different values: the result is the same as
        // if this one had been made after the other.
        written = sanitizeSecretsForPersistence(rebased);
        try {
          draft = await write(written, { value: stored });
        } catch (retryErr) {
          if (!(retryErr instanceof BlockConflictError)) throw retryErr;
          await queryClient.invalidateQueries({
            queryKey: KEYS.decofile(cacheKey),
          });
          throw new BlockConflictError(
            retryErr.blocks,
            t("sectionsEditor.sectionsEditor.blockChangedElsewhere"),
          );
        }
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
      return { ...draft, written };
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
  };

  const mutation = useMutation({
    mutationKey: decofileWriteMutationKey(orgSlug, virtualMcpId, branch),
    // Serialize a branch's writes so overlapping autosaves can't land an older payload last, dropping a newer edit.
    scope: decofileWriteScope(orgSlug, virtualMcpId, branch),
    mutationFn: async ({
      blockKey,
      data,
      base,
      rebaseOnConflict = true,
      guard,
    }: SaveBlockVariables) => {
      // Fail closed before any write path: a raw secret must never be persisted.
      data = sanitizeSecretsForPersistence(data);
      if (protocol) {
        const params = { orgSlug, virtualMcpId, branch };
        const ifMatch = guard?.ifMatch(blockKey);
        try {
          const result = await applyProtocolPatch(
            queryClient,
            protocol,
            params,
            cacheKey,
            { set: { [blockKey]: data } },
            ifMatch,
          );
          if (ifMatch) guard?.onApplied?.(result.versions);
          return result;
        } catch (error) {
          if (ifMatch) guard?.onRejected?.(error);
          if (ifMatch && guard?.reloadOnConflict && isSaveConflict(error)) {
            // As a legacy 409: what is stored now replaces the outdated copy
            // before anything reacts to the refusal.
            await reloadProtocolBlock(
              queryClient,
              protocol,
              params,
              cacheKey,
              blockKey,
            );
            throw new BlockConflictError(
              [blockKey],
              t("sectionsEditor.sectionsEditor.blockChangedElsewhere"),
            );
          }
          throw error;
        }
      }
      // Every other backend: the same pending state, with its own refresh.
      return runContentChange(
        { queryClient, orgSlug, virtualMcpId, branch, backend, cacheKey },
        {
          kind: "edit",
          write: () => writeLegacy(blockKey, data, base, rebaseOnConflict),
        },
      );
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
    // A stale-copy refusal already re-read the block; restoring would put the stale copy back.
    onError: (error, _variables, context) => {
      if (!context || error instanceof BlockConflictError) return;
      // Refused because the content changed on disk: load what is there now.
      if (isSaveConflict(error)) {
        void queryClient.invalidateQueries({ queryKey: context.queryKey });
      }
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
    onSuccess: (result, { blockKey, data }) => {
      // A save replayed on a newer copy stored more than this edit's `data`.
      const stored =
        result && typeof result === "object" && "written" in result
          ? result.written
          : data;
      queryClient.setQueryData(
        KEYS.decofile(cacheKey),
        (current: Record<string, unknown> | undefined) => ({
          ...(current ?? {}),
          [blockKey]: stored,
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
      ? {
          ...variables,
          base: { value: cached[variables.blockKey], fromCache: true },
        }
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
    /** One toast for a failed save, worded for this backend's editor. */
    reportError: (error: Error) =>
      toastSaveError(t, error, protocol?.source ?? null),
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
  opts?: { onSaved?: () => void; guard?: SaveGuard },
) {
  const saveBlock = useSaveBlock(params);
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
      { blockKey, data: resolved, guard: opts?.guard },
      {
        onSuccess: () => opts?.onSaved?.(),
        onError: saveBlock.reportError,
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

  // A discard of a block drops its armed save: fired after the discard, it
  // would bring the discarded edit back (content-sync.ts).
  useContentDiscardListener(params.orgSlug, params.virtualMcpId, (keys) => {
    for (const blockKey of keys) {
      const timer = timersRef.current.get(blockKey);
      if (timer) clearTimeout(timer);
      timersRef.current.delete(blockKey);
      pendingRef.current.delete(blockKey);
    }
  });

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

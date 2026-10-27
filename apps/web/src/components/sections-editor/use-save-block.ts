import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  notifyManager,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { useDecofileCacheKey } from "./use-decofile";
import { useContentBackend } from "./use-content-backend";
import {
  applyProtocolPatch,
  draftCopiesNow,
  neverPublishedBlock,
  protocolMetaQueryKey,
  protocolBlockVersion,
  reloadProtocolBlock,
  rereadProtocolContent,
} from "./content-protocol-api";
import {
  conflictFields,
  planFormConflict,
  resolveFormConflict,
} from "./form-conflict";
import {
  askDeletedConflict,
  askNamedRuleConflict,
  canAskNamedRuleConflict,
} from "./named-rule-conflict";
import {
  blockLabel,
  choseTheirs,
  HOSTED_RECONCILE_ROUNDS,
  hostedIfMatch,
} from "./hosted-reconcile";
import { runContentChange, useContentDiscardListener } from "./content-sync";
import { usePackagePath } from "./use-package-path";
import {
  canonicalBlockJson,
  decoBlockFingerprint,
  mergeBlockJson,
  sanitizeSecretsForPersistence,
} from "@decocms/shared/decofile";
import { sleep } from "@decocms/shared/std";
import { globalSectionLabel } from "./page-list";
import { type LiveMeta, resolveSchema } from "./resolve-schema";
import { decoBlockFilePath } from "./deco-block-key";
import { decoRepoPath } from "./deco-repo-path";
import {
  BlockConflictError,
  type DecofileDraft,
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
import {
  HostedDraftUnreadError,
  inPlainWords,
  isSaveConflict,
} from "./serve-save-error";
import { toastKeptTheirs, toastSaveError } from "./site-editor-toast";
import { describeConflictFields } from "./conflict-fields";
import {
  bumpCopyEpoch,
  copyScope,
  type HeldCopy,
  HeldCopies,
  type HeldEdit,
  heldCopyVersion,
} from "./held-copy";

/** Debounce window for form-driven block autosaves (ms). */
export const AUTOSAVE_DELAY = 700;

interface UseSaveBlockParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

interface UseSaveBlockOptions {
  /**
   * The editor keeps its own copy of the blocks it saves (a form seeded
   * once, not rebuilt from the cache on each save). On a hosted v8 draft
   * each save is then guarded by the version of the copy the editor shows,
   * the one it loaded, moved only by its own confirmed saves (held-copy.ts),
   * so a change someone else made meanwhile is reconciled, never written
   * over. After a reconcile the editor is told to show the draft's copy
   * (`useCopyEpochs`). Other backends: ignored.
   */
  holdsCopy?: boolean;
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
  /**
   * A block this save creates (a section saved under a new name, a copy).
   * On a hosted v8 site it is saved with "must not exist in the draft yet":
   * when someone else created a block of that name first, the reconcile
   * flow asks, value by value, whose version to keep, and the choice is
   * saved over theirs (guarded by their version). Other backends: ignored.
   */
  create?: boolean;
  /**
   * An editor keeping its own copy (holdsCopy): the copy the edit was made
   * on, taken when it was made (`useSaveBlock`'s `edited`). A save of an
   * edit made before the editor's copy was replaced (a keystroke still
   * pending in the old form) is guarded by that copy. Default: the copy the
   * editor shows when the save runs.
   */
  edit?: HeldEdit;
}

/**
 * A hosted save the reconcile flow ended by keeping the draft's copy (their
 * version, or their deletion): nothing was written, and the cache holds the
 * draft's copy. The save's own success toast gives way to
 * {@link toastKeptTheirs}'s.
 */
export interface KeptTheirVersion {
  keptTheirs: true;
  /** The block stays deleted. */
  deleted: boolean;
}

type HostedSaveResult =
  | {
      revision: string;
      versions: Record<string, string | null>;
      written: unknown;
    }
  | KeptTheirVersion;

/** True for a save that kept the draft's copy (see {@link KeptTheirVersion}). */
export function keptTheirVersion(result: unknown): result is KeptTheirVersion {
  return (
    !!result &&
    typeof result === "object" &&
    (result as Partial<KeptTheirVersion>).keptTheirs === true
  );
}

/**
 * Versions of each block this tab saved, as canonical JSON, per decofile cache
 * key and block. Right after a commit the provider can keep answering with the
 * previous head for a few seconds; a re-read that returns one of these is this
 * tab's own past, not another editor's change, and must not be merged in.
 * Module-scoped (outlives any one editor), so entries are capped and
 * LRU-evicted: a long tab session touching many branches/blocks must not grow
 * this map forever.
 */
const ownVersions = new Map<string, string[]>();
const OWN_VERSIONS_KEPT = 20;
const OWN_VERSIONS_TRACKED_KEYS = 200;
const ECHO_RETRY_MS = 1_500;

/** Fetch `key`'s versions, marking it most-recently-used and evicting the oldest key over the cap. */
function touchOwnVersions(key: string): string[] {
  const existing = ownVersions.get(key);
  ownVersions.delete(key);
  const versions = existing ?? [];
  ownVersions.set(key, versions);
  if (ownVersions.size > OWN_VERSIONS_TRACKED_KEYS) {
    const oldest = ownVersions.keys().next().value;
    if (oldest !== undefined) ownVersions.delete(oldest);
  }
  return versions;
}

export function rememberOwnVersion(key: string, value: unknown): void {
  const versions = touchOwnVersions(key);
  versions.push(canonicalBlockJson(value));
  if (versions.length > OWN_VERSIONS_KEPT) versions.shift();
}

export function isOwnVersion(key: string, value: unknown): boolean {
  return touchOwnVersions(key).includes(canonicalBlockJson(value));
}

/** Test-only: how many distinct block keys are currently tracked. */
export function ownVersionsTrackedKeyCount(): number {
  return ownVersions.size;
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

export function useSaveBlock(
  { orgSlug, virtualMcpId, branch }: UseSaveBlockParams,
  options?: UseSaveBlockOptions,
) {
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
  const hosted = protocol?.source === "github";
  // The copies the editor shows (holdsCopy), taken when it mounted, or on
  // the first render after the draft was read.
  const [heldCopies] = useState(() =>
    options?.holdsCopy
      ? new HeldCopies(() => draftCopiesNow(queryClient, cacheKey))
      : null,
  );
  heldCopies?.settle();
  const held = hosted ? heldCopies : null;

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
      const versionsKey = `${cacheKey}:${blockKey}`;
      const refused = (blocks: string[], fields: string[] = []) =>
        new BlockConflictError(
          blocks,
          fields.length > 0
            ? t("sectionsEditor.sectionsEditor.blockFieldsChangedElsewhere", {
                fields: describeConflictFields(fields),
              })
            : t("sectionsEditor.sectionsEditor.blockChangedElsewhere"),
          fields,
        );
      /** The server refused `data` as built on an outdated copy. */
      const recover = async (
        err: BlockConflictError,
      ): Promise<{ draft: DecofileDraft; written: unknown }> => {
        // Re-read first, so whatever reacts to the outcome sees the
        // branch's current copy rather than the one this edit was built on.
        await queryClient.invalidateQueries({
          queryKey: KEYS.decofile(cacheKey),
        });
        const stored = queryClient.getQueryData<Record<string, unknown>>(
          KEYS.decofile(cacheKey),
        )?.[blockKey];
        // The re-read returned an older save of this tab: the provider is
        // still answering with a previous head. Send the same edit again
        // once it has caught up.
        if (
          base &&
          isOwnVersion(versionsKey, stored) &&
          canonicalBlockJson(stored) !== canonicalBlockJson(base.value)
        ) {
          await sleep(ECHO_RETRY_MS);
          return { draft: await write(data, base), written: data };
        }
        const fields: string[] = [];
        const rebased =
          rebaseOnConflict && base?.fromCache
            ? mergeBlockJson(base.value, data, stored, {
                prefer: "theirs",
                conflicts: fields,
              })
            : undefined;
        if (rebased === undefined || fields.length > 0) {
          throw refused(err.blocks, fields);
        }
        // The two edits touched different values: the result is the same as
        // if this one had been made after the other.
        const merged = sanitizeSecretsForPersistence(rebased);
        return {
          draft: await write(merged, { value: stored }),
          written: merged,
        };
      };
      let written = data;
      let draft: DecofileDraft;
      try {
        draft = await write(data, base);
      } catch (err) {
        if (!(err instanceof BlockConflictError)) throw err;
        try {
          ({ draft, written } = await recover(err));
        } catch (retryErr) {
          if (!(retryErr instanceof BlockConflictError)) throw retryErr;
          if (retryErr.fields.length > 0) throw retryErr;
          await queryClient.invalidateQueries({
            queryKey: KEYS.decofile(cacheKey),
          });
          throw refused(retryErr.blocks);
        }
      }
      rememberOwnVersion(versionsKey, written);
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

  /**
   * A hosted v8 save with no guard of its own (every block editor but the
   * section form): checked against the draft alone, `ifMatch` the draft's
   * version of the block (`null` when the draft doesn't hold it, the
   * tombstone's when the draft deletes it), or "must not exist in the
   * draft" for a create (see {@link SaveBlockVariables.create}). Refused:
   * the draft's copy (the refusal carries it) is put in the cache, values
   * only one side changed merge on their own, the rest is the user's choice
   * (the reconcile flow), and a block the draft deleted asks "Keep my
   * version" or "Leave it deleted". The result is saved guarded by the
   * draft's version again. Nothing is written over someone else's change,
   * and no edit is dropped, without that choice.
   */
  const saveHostedBlock = async (
    params: { orgSlug: string; virtualMcpId: string; branch: string },
    blockKey: string,
    data: unknown,
    base: SaveBlockBase | undefined,
    create: boolean,
    /** The copy the editor shows (holdsCopy): its version guards the save. */
    shown?: HeldCopy,
  ): Promise<HostedSaveResult> => {
    const backend = protocol!;
    const ctx = { queryClient, backend, params, cacheKey };
    let value = data;
    /**
     * What both sides changed from: the copy the edit was built on. A create
     * starts from none, so a name the draft deletes is created over the
     * deletion with no question (nothing it edited was deleted), and a name
     * someone else created first is reconciled value by value from `{}`.
     * An editor that keeps its own copy built the edit on that copy.
     */
    let ancestor: unknown = create
      ? undefined
      : shown
        ? shown.value
        : base?.value;
    let ifMatch: Record<string, string | null> = create
      ? { [blockKey]: null }
      : shown
        ? { [blockKey]: await heldCopyVersion(shown) }
        : await hostedIfMatch(ctx, [blockKey]);
    for (let round = 0; ; round++) {
      try {
        const result = await applyProtocolPatch(
          queryClient,
          backend,
          params,
          cacheKey,
          { set: { [blockKey]: value } },
          ifMatch,
        );
        return { ...result, written: value };
      } catch (error) {
        if (!isSaveConflict(error)) throw error;
        const carried = await reloadProtocolBlock(
          queryClient,
          backend,
          params,
          cacheKey,
          blockKey,
          error,
        );
        const stored = queryClient.getQueryData<Record<string, unknown>>(
          KEYS.decofile(cacheKey),
        )?.[blockKey];
        const version = protocolBlockVersion(
          queryClient,
          cacheKey,
          blockKey,
          backend,
        );
        const mine = value;
        if (
          round + 1 >= HOSTED_RECONCILE_ROUNDS ||
          !canAskNamedRuleConflict() ||
          version === undefined ||
          !isRecord(mine) ||
          (stored !== undefined && !isRecord(stored))
        ) {
          // The draft's copy is in the cache: the message says what to do.
          throw new BlockConflictError(
            [blockKey],
            round + 1 >= HOSTED_RECONCILE_ROUNDS
              ? t("siteEditor.save.keptChanging")
              : t("siteEditor.save.conflict"),
            [],
            carried,
          );
        }
        ifMatch = { [blockKey]: version };
        if (!isRecord(stored)) {
          // A block the edit didn't start from (a create): gone again
          // meanwhile, or deleted in the draft, it is created as first meant.
          if (!isRecord(ancestor)) continue;
          // Deleted in the draft while the user edited it: their choice.
          const choice = await askDeletedConflict({
            kind: "theyDeleted",
            // Named as it was deleted (a rename's new name never was).
            label: blockLabel(blockKey, ancestor, mine),
          });
          if (choice === "theirs") return { keptTheirs: true, deleted: true };
          ancestor = undefined;
          continue;
        }
        const plan = planFormConflict({
          ancestor: isRecord(ancestor) ? ancestor : {},
          mine,
          theirs: stored,
        });
        // Asked as the block's own editor would: the block by its title,
        // each value by the form's label, and who changed it when known.
        const choices =
          plan.pointers.length === 0
            ? {}
            : await askNamedRuleConflict(
                plan,
                conflictFields(plan, blockSchema(params, stored), true),
                {
                  block: globalSectionLabel(blockKey, stored),
                  author: { draft: params, blockKey },
                },
              );
        value =
          plan.pointers.length === 0
            ? plan.merged
            : resolveFormConflict(plan, choices);
        if (
          choseTheirs(choices) &&
          canonicalBlockJson(value) === canonicalBlockJson(stored)
        ) {
          return { keptTheirs: true, deleted: false };
        }
        ancestor = stored;
      }
    }
  };

  /** The form schema of `block` (its `__resolveType`'s), from the cache. */
  const blockSchema = (
    params: { orgSlug: string; virtualMcpId: string; branch: string },
    block: Record<string, unknown>,
  ) => {
    const resolveType = block.__resolveType;
    const meta = queryClient.getQueryData<LiveMeta>(
      protocolMetaQueryKey(params, protocol!),
    );
    if (typeof resolveType !== "string" || !meta?.manifest) return null;
    try {
      return resolveSchema(resolveType, meta);
    } catch {
      return null;
    }
  };

  /**
   * A section form's hosted save (its own guard) refused because the draft
   * deleted the block: the user's edit never vanishes silently. Asked "Keep
   * my version" (saved over the deletion, guarded by its tombstone) or
   * "Leave it deleted". Undefined when the draft holds the block (the form
   * reconciles values itself) or nobody can be asked.
   */
  const keepOverDeletion = async (
    params: { orgSlug: string; virtualMcpId: string; branch: string },
    blockKey: string,
    data: unknown,
    guard: SaveGuard,
    base: SaveBlockBase | undefined,
  ): Promise<HostedSaveResult | undefined> => {
    const backend = protocol!;
    const cached = queryClient.getQueryData<Record<string, unknown>>(
      KEYS.decofile(cacheKey),
    );
    if (cached && Object.hasOwn(cached, blockKey)) return undefined;
    if (!canAskNamedRuleConflict() || !isRecord(data)) return undefined;
    const choice = await askDeletedConflict({
      kind: "theyDeleted",
      label: blockLabel(blockKey, base?.value, data),
    });
    if (choice === "theirs") return { keptTheirs: true, deleted: true };
    const version = protocolBlockVersion(
      queryClient,
      cacheKey,
      blockKey,
      backend,
    );
    if (version === undefined) return undefined;
    const result = await applyProtocolPatch(
      queryClient,
      backend,
      params,
      cacheKey,
      { set: { [blockKey]: data } },
      { [blockKey]: version },
    );
    guard.onApplied?.(result.versions);
    return { ...result, written: data };
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
      create = false,
      edit,
    }: SaveBlockVariables) => {
      // Fail closed before any write path: a raw secret must never be
      // persisted. A hosted save checks nothing (the site's CI runs `deco
      // check`); secrets live in the deploy platform there.
      if (protocol?.source !== "github") {
        data = sanitizeSecretsForPersistence(data);
      }
      if (protocol) {
        const params = { orgSlug, virtualMcpId, branch };
        /** An editor's own confirmed save moves the copy it holds. */
        const keepShown = (result: HostedSaveResult) => {
          if (!held || keptTheirVersion(result)) return;
          if (canonicalBlockJson(result.written) !== canonicalBlockJson(data)) {
            return;
          }
          if (result.versions[blockKey]) held.saved(blockKey, data);
        };
        // Every hosted save is guarded by the draft (see saveHostedBlock).
        if (hosted && !guard) {
          const result = await saveHostedBlock(
            params,
            blockKey,
            data,
            base,
            create,
            create ? undefined : held?.guardOf(blockKey, edit),
          );
          keepShown(result);
          return result;
        }
        // An editor's own guard that isn't a form's (Settings' create-only
        // `CMS` guard): its "must not exist" makes the save a create, and no
        // guard of its own means the draft's version. Either way a refusal
        // opens the reconcile flow rather than failing.
        if (hosted && guard && !guard.reloadOnConflict) {
          const own = guard.ifMatch(blockKey);
          const creates = create || (!!own && own[blockKey] === null);
          try {
            const result = await saveHostedBlock(
              params,
              blockKey,
              data,
              base,
              creates,
              creates ? undefined : held?.guardOf(blockKey, edit),
            );
            keepShown(result);
            guard.onApplied?.(keptTheirVersion(result) ? {} : result.versions);
            return result;
          } catch (error) {
            guard.onRejected?.(error);
            throw error;
          }
        }
        let ifMatch = guard?.ifMatch(blockKey);
        if (guard && !ifMatch && hosted) {
          // Every hosted save carries its precondition: an unknown version
          // is read first (the draft's changes come with the content).
          await rereadProtocolContent(
            queryClient,
            protocol,
            params,
            cacheKey,
          ).catch(() => {
            throw new HostedDraftUnreadError();
          });
          ifMatch = guard.ifMatch(blockKey);
          // Still unknown: fail rather than write unguarded.
          if (!ifMatch) throw new HostedDraftUnreadError();
        }
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
            const carried = await reloadProtocolBlock(
              queryClient,
              protocol,
              params,
              cacheKey,
              blockKey,
              error,
            );
            if (hosted) {
              try {
                const kept = await keepOverDeletion(
                  params,
                  blockKey,
                  data,
                  guard,
                  base,
                );
                if (kept) return kept;
              } catch (retryError) {
                if (!isSaveConflict(retryError)) throw retryError;
              }
            }
            throw new BlockConflictError(
              [blockKey],
              t("sectionsEditor.sectionsEditor.blockChangedElsewhere"),
              [],
              carried,
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
      // A hosted dead end says what to do, wherever its message shows.
      inPlainWords(t, error);
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
      /**
       * The draft now holds something else than the editor's copy (their
       * version, their deletion, a merge): an editor keeping its own copy
       * shows the draft's, once the cache's readers rendered it.
       */
      const showDraft = () => {
        if (!held) return;
        const scope = copyScope({ orgSlug, virtualMcpId, branch });
        notifyManager.schedule(() => bumpCopyEpoch(scope, blockKey));
      };
      // The user kept the draft's copy (the cache holds it): one calm toast.
      if (keptTheirVersion(result)) {
        toastKeptTheirs(
          t,
          result.deleted,
          result.deleted &&
            neverPublishedBlock(queryClient, cacheKey, blockKey),
        );
        showDraft();
        return;
      }
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
      if (canonicalBlockJson(stored) !== canonicalBlockJson(data)) showDraft();
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
    /**
     * The editor (holdsCopy) seeded its form again from the draft's copy of
     * `blockKey` as the cache holds it now: later saves are guarded by it.
     */
    hold: (blockKey: string) => heldCopies?.hold(blockKey),
    /** True while saves are guarded by the editor's own copy (hosted v8). */
    holdsCopy: held !== null,
    /**
     * An edit of `blockKey` is made now (holdsCopy): the copy it is built
     * on, for its save's `edit`. Undefined when saves aren't guarded by the
     * editor's own copy.
     */
    edited: (blockKey: string) => held?.edited(blockKey),
    /**
     * The editor's own copy of `blockKey` (hosted v8, holdsCopy), for a move
     * or rename built from it (`useMoveBlocks`' `shown`); undefined
     * otherwise.
     */
    shown: (blockKey: string) => held?.get(blockKey),
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
  opts?: { onSaved?: () => void; guard?: SaveGuard; holdsCopy?: boolean },
) {
  const saveBlock = useSaveBlock(params, { holdsCopy: opts?.holdsCopy });
  const pendingRef = useRef<Map<string, SaveData>>(new Map());
  // The copy each pending edit was made on (holdsCopy): the first edit of
  // the window, so one made before the form was reseeded keeps its guard.
  const editsRef = useRef<Map<string, HeldEdit>>(new Map());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const runPendingSave = (blockKey: string) => {
    const pending = pendingRef.current.get(blockKey);
    if (!pending) return;
    const resolved = typeof pending === "function" ? pending() : pending;
    pendingRef.current.delete(blockKey);
    const edit = editsRef.current.get(blockKey);
    editsRef.current.delete(blockKey);
    if (!resolved) return;
    saveBlock.mutate(
      { blockKey, data: resolved, guard: opts?.guard, edit },
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
      editsRef.current.delete(blockKey);
    }
  });

  // Cancel pending debounced saves on unmount so they can't fire against a torn
  // -down editor after navigation. Call `flush()` explicitly when closing a sheet
  // or leaving an editor so edits inside the debounce window still persist.
  // An editor keeping its own copy on a hosted v8 draft saves them instead:
  // it unmounts when the draft's copy replaces its form (a reconcile, a
  // deletion), and a pending edit is reconciled against it, never dropped.
  const flushHeldOnUnmount = useEffectEvent(() => {
    if (saveBlock.holdsCopy) flush();
    return saveBlock.holdsCopy;
  });
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — timer lifecycle cleanup on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      if (flushHeldOnUnmount()) return;
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  const save = (blockKey: string, data: SaveData) => {
    if (!editsRef.current.has(blockKey)) {
      const edit = saveBlock.edited(blockKey);
      if (edit) editsRef.current.set(blockKey, edit);
    }
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

  return {
    save,
    flush,
    isPending: saveBlock.isPending,
    hold: saveBlock.hold,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

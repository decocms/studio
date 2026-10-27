import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ContentProtocolError, ErrorCode } from "@decocms/blocks/protocol";
import {
  canonicalBlockJson,
  sanitizeSecretsForPersistence,
} from "@decocms/shared/decofile";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import {
  applyProtocolPatch,
  protocolBlockVersion,
  reloadProtocolBlock,
  rereadProtocolContent,
  savingBlockKeys,
} from "./content-protocol-api";
import {
  type DecofilePatchBody,
  decofileWriteMutationKey,
  decofileWriteScope,
} from "./decofile-api";
import { isSaveConflict } from "./serve-save-error";
import { SAVE_TOAST, toastSaveError } from "./site-editor-toast";
import { useContentBackend } from "./use-content-backend";
import { useDecofileCacheKey } from "./use-decofile";
import { applyMoveToDecofile } from "./use-move-blocks";

/**
 * One change to the site's A/B tests or campaigns (named-rules.ts): the
 * `experiments` or `campaigns` block, and the blocks whose rules use its
 * names (a page or section given a new rule, every rule a rename rewrites).
 */
export interface NamedRuleChange {
  /** Blocks written whole. */
  writes: Record<string, Record<string, unknown>>;
  /** Blocks removed. */
  deletes?: string[];
}

export type NamedRuleApplyPlan =
  | {
      kind: "apply";
      patch: DecofilePatchBody;
      ifMatch: Record<string, string | null>;
    }
  /** The editor hasn't read these blocks' versions yet: read, then retry. */
  | { kind: "unread"; blockKeys: string[] };

/**
 * The one `blocks.apply` of a change, every block it touches guarded by the
 * version the editor's copy came from (`null`: it must not exist yet). So a
 * test or campaign created meanwhile is never replaced, a rule is never added
 * to a page someone else just changed, and either both land or neither does.
 */
export function planNamedRuleApply(
  change: NamedRuleChange,
  versionOf: (blockKey: string) => string | null | undefined,
): NamedRuleApplyPlan {
  const deletes = (change.deletes ?? []).filter(
    (key) => !Object.hasOwn(change.writes, key),
  );
  const touched = [...Object.keys(change.writes), ...deletes];
  const ifMatch: Record<string, string | null> = {};
  const unread: string[] = [];
  for (const blockKey of touched) {
    const version = versionOf(blockKey);
    if (version === undefined) unread.push(blockKey);
    else ifMatch[blockKey] = version;
  }
  if (unread.length > 0) return { kind: "unread", blockKeys: unread };
  return {
    kind: "apply",
    patch: {
      set: change.writes,
      ...(deletes.length > 0 ? { delete: deletes } : {}),
    },
    ifMatch,
  };
}

export type NamedRuleApplyOutcome =
  | { ok: true }
  /**
   * Not written. `changed`: a block changed meanwhile (or wasn't read yet);
   * the editor now holds the stored copies, so the user can look and redo.
   * `unavailable`: the site's content can't be written right now.
   * `failed`: the write failed; the toast says why.
   */
  | { ok: false; reason: "changed" | "unavailable" | "failed" };

/** The blocks of a change, as the write queue's variables carry them. */
interface NamedRuleWrite {
  writes: Record<string, Record<string, unknown>>;
  deletes: string[];
  /**
   * The versions of the copies the change was built on, as known when it
   * was made. A block missing here was held by an earlier save of this
   * editor still on its way: it takes the version that save answers.
   */
  pinned: Record<string, string | null>;
}

/** A version unknown when the write runs: as refused, so nothing is guessed. */
function unreadConflict(blockKeys: string[]): ContentProtocolError {
  return new ContentProtocolError(ErrorCode.Conflict, "not read yet", {
    entries: Object.fromEntries(
      blockKeys.map((key) => [key, { expected: null, actual: null }]),
    ),
  });
}

/**
 * Writes a {@link NamedRuleChange} into the editor's draft as ONE guarded
 * `blocks.apply`; it goes live with the next Publish, like any other edit.
 * The editor's copy changes at once and comes back if the write fails. A
 * refused write reads the stored blocks again and says so in one calm toast;
 * nothing is retried over someone else's change.
 *
 * The guard is the version of the copy the change was built on. The cache
 * already holds the editor's earlier saves still on their way, so a block
 * one of them holds is guarded by the version that save answers, read when
 * this write runs (after it landed, as a section form's is); every other
 * block by the version known when the change was made. The change's blocks
 * count as being saved while it waits, so a poll meanwhile keeps their
 * copies and versions, and someone else's save of them is still refused.
 */
export function useApplyNamedRule({
  orgSlug,
  virtualMcpId,
  branch,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const backend = useContentBackend(virtualMcpId, branch);
  const protocol = backend.kind === "protocol" ? backend : null;
  const cacheKey = useDecofileCacheKey({ orgSlug, virtualMcpId, branch });
  const params = { orgSlug, virtualMcpId, branch };
  const queryKey = KEYS.decofile(cacheKey);

  const mutation = useMutation({
    mutationKey: decofileWriteMutationKey(orgSlug, virtualMcpId, branch),
    scope: decofileWriteScope(orgSlug, virtualMcpId, branch),
    mutationFn: async (write: NamedRuleWrite) => {
      const plan = planNamedRuleApply(write, (blockKey) =>
        Object.hasOwn(write.pinned, blockKey)
          ? write.pinned[blockKey]
          : protocolBlockVersion(queryClient, cacheKey, blockKey),
      );
      if (plan.kind === "unread") throw unreadConflict(plan.blockKeys);
      return applyProtocolPatch(
        queryClient,
        protocol!,
        params,
        cacheKey,
        plan.patch,
        plan.ifMatch,
      );
    },
  });

  const changedMeanwhile = async (blockKeys: string[]) => {
    for (const blockKey of blockKeys) {
      await reloadProtocolBlock(
        queryClient,
        protocol!,
        params,
        cacheKey,
        blockKey,
      );
    }
    toast.info(t("sectionsEditor.namedRules.changedMeanwhile"), {
      ...SAVE_TOAST,
      description: t("sectionsEditor.namedRules.changedMeanwhileHint"),
    });
    return { ok: false, reason: "changed" } as const;
  };

  const apply = async (
    change: NamedRuleChange,
  ): Promise<NamedRuleApplyOutcome> => {
    if (!protocol) {
      toast.info(t("sectionsEditor.namedRules.unavailable"), {
        ...SAVE_TOAST,
        description: t("sectionsEditor.namedRules.unavailableHint"),
      });
      return { ok: false, reason: "unavailable" };
    }
    const writes = sanitizeSecretsForPersistence(change.writes);
    const deletes = (change.deletes ?? []).filter(
      (key) => !Object.hasOwn(writes, key),
    );
    const touched = [...Object.keys(writes), ...deletes];
    const previous =
      queryClient.getQueryData<Record<string, unknown>>(queryKey);
    const pinned = await pinVersions(touched, previous);
    if (!pinned) return changedMeanwhile(touched);
    const before = new Map<string, unknown>();
    for (const key of touched) {
      if (previous && Object.hasOwn(previous, key)) {
        before.set(key, previous[key]);
      }
    }
    queryClient.setQueryData(queryKey, (current) =>
      applyMoveToDecofile(current as Record<string, unknown> | undefined, {
        writes,
        deletes,
      }),
    );
    void queryClient.cancelQueries({ queryKey });
    try {
      await mutation.mutateAsync({ writes, deletes, pinned });
      return { ok: true };
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
      if (isSaveConflict(error)) return changedMeanwhile(touched);
      toastSaveError(
        t,
        error instanceof Error ? error : new Error(String(error)),
        protocol.source,
      );
      return { ok: false, reason: "failed" };
    }
  };

  /**
   * The versions of the copies a change was built on (`copies`, the cache
   * when it was made), for every block no earlier save still on its way
   * holds (those take that save's answer when the write runs). A block with
   * no known version (the editor's bookkeeping was lost) is read now: when
   * it is stored exactly as the change found it, the version just read is
   * its copy's; when it isn't, someone else changed it: `null`, nothing is
   * written.
   */
  const pinVersions = async (
    touched: string[],
    copies: Record<string, unknown> | undefined,
  ): Promise<Record<string, string | null> | null> => {
    const saving = savingBlockKeys(queryClient, params);
    const pinned: Record<string, string | null> = {};
    const unread: string[] = [];
    for (const key of touched) {
      if (saving.has(key)) continue;
      const version = protocolBlockVersion(queryClient, cacheKey, key);
      if (version === undefined) unread.push(key);
      else pinned[key] = version;
    }
    if (unread.length === 0) return pinned;
    const fresh = await reread();
    if (!fresh) return null;
    for (const key of unread) {
      const had = !!copies && Object.hasOwn(copies, key);
      if (had !== Object.hasOwn(fresh, key)) return null;
      if (
        had &&
        canonicalBlockJson(fresh[key]) !== canonicalBlockJson(copies![key])
      ) {
        return null;
      }
      const version = protocolBlockVersion(queryClient, cacheKey, key);
      if (version === undefined) return null;
      pinned[key] = version;
    }
    return pinned;
  };

  /**
   * The draft as stored right now (content-protocol-api.ts
   * `rereadProtocolContent`): what a delete, an Undo or a rename plans from,
   * so a use or a name another tab added meanwhile counts. `null` when it can't be
   * read; the caller then changes nothing.
   */
  const reread = async (): Promise<Record<string, unknown> | null> => {
    if (!protocol) return null;
    try {
      const content = await rereadProtocolContent(
        queryClient,
        protocol,
        params,
        cacheKey,
      );
      return content.blocks;
    } catch {
      return null;
    }
  };

  /**
   * A change planned from the draft as stored right now, for one that takes a
   * name away (a rename): a use another tab added meanwhile is rewritten
   * with the others, never left naming a test or campaign that is gone.
   * `null`, with one calm toast, when the draft can't be read or the change
   * no longer fits what is stored (it now shows that).
   */
  const planStored = async (
    plan: (decofile: Record<string, unknown>) => NamedRuleChange | null,
  ): Promise<NamedRuleChange | null> => {
    const fresh = await reread();
    if (!fresh) {
      toast.info(t("sectionsEditor.namedRules.unavailable"), {
        ...SAVE_TOAST,
        description: t("sectionsEditor.namedRules.unavailableHint"),
      });
      return null;
    }
    const change = plan(fresh);
    if (!change) {
      toast.info(t("sectionsEditor.namedRules.changedMeanwhile"), {
        ...SAVE_TOAST,
        description: t("sectionsEditor.namedRules.changedMeanwhileHint"),
      });
    }
    return change;
  };

  return { apply, reread, planStored, isPending: mutation.isPending };
}

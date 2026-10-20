import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sanitizeSecretsForPersistence } from "@decocms/shared/decofile";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import {
  applyProtocolPatch,
  protocolBlockVersion,
  reloadProtocolBlock,
} from "./content-protocol-api";
import {
  type DecofilePatchBody,
  decofileWriteMutationKey,
  decofileWriteScope,
} from "./decofile-api";
import { isSaveConflict } from "./serve-save-error";
import { SITE_EDITOR_SAVE_TOAST, toastSaveError } from "./site-editor-toast";
import { useContentBackend } from "./use-content-backend";
import { useDecofileCacheKey } from "./use-decofile";
import { applyMoveToDecofile } from "./use-move-blocks";

/**
 * One change to the site's A/B tests or campaigns (named-rules.ts): the
 * `Experiments` or `Schedules` block, and the blocks whose rules use its
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

/**
 * Writes a {@link NamedRuleChange} into the editor's draft as ONE guarded
 * `blocks.apply`; it goes live with the next Publish, like any other edit.
 * The editor's copy changes at once and comes back if the write fails. A
 * refused write reads the stored blocks again and says so in one calm toast;
 * nothing is retried over someone else's change.
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
    mutationFn: (plan: Extract<NamedRuleApplyPlan, { kind: "apply" }>) =>
      applyProtocolPatch(
        queryClient,
        protocol!,
        params,
        cacheKey,
        plan.patch,
        plan.ifMatch,
      ),
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
      id: SITE_EDITOR_SAVE_TOAST,
      description: t("sectionsEditor.namedRules.changedMeanwhileHint"),
    });
    return { ok: false, reason: "changed" } as const;
  };

  const apply = async (
    change: NamedRuleChange,
  ): Promise<NamedRuleApplyOutcome> => {
    if (!protocol) {
      toast.info(t("sectionsEditor.namedRules.unavailable"), {
        id: SITE_EDITOR_SAVE_TOAST,
        description: t("sectionsEditor.namedRules.unavailableHint"),
      });
      return { ok: false, reason: "unavailable" };
    }
    const writes = sanitizeSecretsForPersistence(change.writes);
    const plan = planNamedRuleApply({ ...change, writes }, (blockKey) =>
      protocolBlockVersion(queryClient, cacheKey, blockKey),
    );
    if (plan.kind === "unread") return changedMeanwhile(plan.blockKeys);

    const touched = [...Object.keys(writes), ...(plan.patch.delete ?? [])];
    const previous =
      queryClient.getQueryData<Record<string, unknown>>(queryKey);
    const before = new Map<string, unknown>();
    for (const key of touched) {
      if (previous && Object.hasOwn(previous, key)) {
        before.set(key, previous[key]);
      }
    }
    queryClient.setQueryData(queryKey, (current) =>
      applyMoveToDecofile(current as Record<string, unknown> | undefined, {
        writes,
        deletes: plan.patch.delete ?? [],
      }),
    );
    void queryClient.cancelQueries({ queryKey });
    try {
      await mutation.mutateAsync(plan);
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

  return { apply, isPending: mutation.isPending };
}

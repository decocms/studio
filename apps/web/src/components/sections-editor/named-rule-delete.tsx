/**
 * Delete for a test (Experiments tab) or a campaign (Campaigns view). A name
 * that pages still use can't be deleted: a dialog asks the editor to take it
 * off those pages first and lists them, each one opening in the site editor;
 * a saved rule that names it is listed too, beside the pages that use it, and
 * one that nothing uses can be removed right there. An unused name is deleted
 * from the draft at once, with an Undo.
 *
 * Every decision reads the draft as stored right now (another tab may have
 * changed it): Delete plans from that copy, so a use added meanwhile blocks
 * it, and Undo puts back only the deleted name onto the block as it is then,
 * so a test or campaign created since stays.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Trash01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { useT } from "@/i18n/use-t.ts";
import {
  planNamedRuleDelete,
  planNamedRuleRestore,
  planSavedRuleRemove,
} from "./named-rule-edits";
import { NamedRuleUseList } from "./named-rule-used-by";
import {
  type NamedRuleUseRow,
  type NamedRuleUses,
  namedRuleBlockingRows,
  namedRuleUses,
} from "./named-rule-uses";
import { type NamedRuleKind, readNamedRuleBlock } from "./named-rules";
import type { LiveMeta } from "./resolve-schema";
import { SITE_EDITOR_SAVE_TOAST } from "./site-editor-toast";
import type {
  NamedRuleApplyOutcome,
  NamedRuleChange,
} from "./use-apply-named-rule";

type NamedRuleDeletePlan =
  /** Pages still use it: these, one row per block and variant. */
  | { kind: "in-use"; rows: NamedRuleUseRow[] }
  | { kind: "delete"; change: NamedRuleChange; raw: unknown }
  /** Nothing to delete (the name is already gone). */
  | { kind: "none" };

/** The rows that keep `name` from being deleted, in `decofile` as it is. */
function blockingRows(
  kind: NamedRuleKind,
  name: string,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): NamedRuleUseRow[] {
  const uses = namedRuleUses({
    decofile,
    meta,
    changeCount: 0,
    sides: undefined,
  });
  return namedRuleBlockingRows(uses, kind, name, decofile, meta);
}

/** What Delete does for `name`, planned from the draft as stored now. */
function planNamedRuleDeleteAction(input: {
  kind: NamedRuleKind;
  name: string;
  decofile: Record<string, unknown>;
  meta?: LiveMeta | null;
}): NamedRuleDeletePlan {
  const { kind, name, decofile, meta } = input;
  const rows = blockingRows(kind, name, decofile, meta);
  if (rows.length > 0) return { kind: "in-use", rows };
  const change = planNamedRuleDelete(decofile, kind, name);
  if (!change) return { kind: "none" };
  const read = readNamedRuleBlock(decofile, kind);
  return {
    kind: "delete",
    change,
    raw: read.kind === "saved" ? read.block[name] : undefined,
  };
}

export function NamedRuleDeleteButton({
  kind,
  name,
  meta,
  uses,
  pending,
  apply,
  reread,
  onDeleted,
  onUndo,
  onOpenUse,
}: {
  kind: NamedRuleKind;
  name: string;
  meta?: LiveMeta | null;
  /** "Used by" for the view; Delete waits until it is read. */
  uses: NamedRuleUses | null;
  /** A change is being saved. */
  pending: boolean;
  apply: (change: NamedRuleChange) => Promise<NamedRuleApplyOutcome>;
  /** The draft as stored right now; `null` when it can't be read. */
  reread: () => Promise<Record<string, unknown> | null>;
  /** The name left the draft. */
  onDeleted: () => void;
  /** Undo: writes the change that puts the name back. */
  onUndo: (change: NamedRuleChange) => void;
  onOpenUse: (row: NamedRuleUseRow) => void;
}) {
  const t = useT();
  const tests = kind === "experiments";
  const [blocking, setBlocking] = useState<NamedRuleUseRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const loading = !uses || checking;

  /** The draft right now, or a calm toast and `null`. */
  const readNow = async () => {
    const fresh = await reread();
    if (!fresh) {
      toast.info(t("sectionsEditor.namedRules.unavailable"), {
        id: SITE_EDITOR_SAVE_TOAST,
        description: t("sectionsEditor.namedRules.unavailableHint"),
      });
    }
    return fresh;
  };

  const undo = async (raw: unknown) => {
    const fresh = await readNow();
    if (!fresh) return;
    const change = planNamedRuleRestore(fresh, kind, name, raw);
    if (change) onUndo(change);
  };

  const remove = async () => {
    setChecking(true);
    let plan: NamedRuleDeletePlan;
    try {
      const fresh = await readNow();
      if (!fresh) return;
      plan = planNamedRuleDeleteAction({ kind, name, decofile: fresh, meta });
    } finally {
      setChecking(false);
    }
    if (plan.kind === "in-use") {
      setBlocking(plan.rows);
      return;
    }
    if (plan.kind !== "delete") return;
    const outcome = await apply(plan.change);
    if (!outcome.ok) return;
    onDeleted();
    const { raw } = plan;
    toast.success(
      tests
        ? t("experiments.v8.deleted", { name })
        : t("sandbox.dateCampaigns.deleted", { name }),
      {
        id: SITE_EDITOR_SAVE_TOAST,
        description: tests
          ? t("experiments.v8.deletedHint")
          : t("sandbox.dateCampaigns.deletedHint"),
        action: {
          label: tests
            ? t("experiments.v8.undo")
            : t("sandbox.dateCampaigns.undo"),
          onClick: () => void undo(raw),
        },
      },
    );
  };

  /** A saved rule nothing uses: removed from the draft, with an Undo. */
  const removeRule = async (row: NamedRuleUseRow) => {
    const fresh = await readNow();
    if (!fresh) return;
    const change = planSavedRuleRemove(fresh, row.blockKey, meta);
    if (change) {
      const value = fresh[row.blockKey];
      const outcome = await apply(change);
      if (outcome.ok) {
        toast.success(
          t("sectionsEditor.namedRuleDelete.ruleRemoved", { name: row.title }),
          {
            id: SITE_EDITOR_SAVE_TOAST,
            action: {
              label: t("sectionsEditor.namedRuleDelete.undo"),
              onClick: () =>
                onUndo({
                  writes: { [row.blockKey]: value as Record<string, unknown> },
                }),
            },
          },
        );
      }
    }
    // What still keeps the name, as stored now.
    const after = (await reread()) ?? fresh;
    const rows = blockingRows(kind, name, after, meta);
    setBlocking(rows.length > 0 ? rows : null);
  };

  const withRules = (blocking ?? []).some((row) => row.blockKind === "rule");

  return (
    <>
      <div className="flex items-center gap-2">
        {loading && (
          <span
            className="text-xs text-muted-foreground"
            data-testid="named-rule-delete-loading"
          >
            {t("sectionsEditor.namedRuleUses.loading")}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending || loading}
          onClick={() => void remove()}
        >
          <Trash01 size={16} />
          {tests
            ? t("experiments.v8.delete")
            : t("sandbox.dateCampaigns.delete")}
        </Button>
      </div>
      <Dialog
        open={blocking !== null}
        onOpenChange={(open) => !open && setBlocking(null)}
      >
        <DialogContent
          className="sm:max-w-lg"
          closeButtonClassName="hidden"
          data-testid="named-rule-in-use"
        >
          <DialogHeader>
            <DialogTitle>
              {tests
                ? t("sectionsEditor.namedRuleDelete.inUseTests")
                : t("sectionsEditor.namedRuleDelete.inUseCampaigns")}
            </DialogTitle>
            <DialogDescription>
              {tests
                ? withRules
                  ? t("sectionsEditor.namedRuleDelete.inUseTestsHintRules", {
                      name,
                    })
                  : t("sectionsEditor.namedRuleDelete.inUseTestsHint", {
                      name,
                    })
                : withRules
                  ? t(
                      "sectionsEditor.namedRuleDelete.inUseCampaignsHintRules",
                      { name },
                    )
                  : t("sectionsEditor.namedRuleDelete.inUseCampaignsHint", {
                      name,
                    })}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto">
            <NamedRuleUseList
              rows={blocking ?? []}
              marked={false}
              onOpen={(row) => {
                setBlocking(null);
                onOpenUse(row);
              }}
              onRemoveRule={pending ? undefined : (row) => void removeRule(row)}
            />
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setBlocking(null)}>
              {t("sectionsEditor.namedRuleDelete.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Delete for a test (Experiments tab) or a campaign (Campaigns view). A name
 * that pages still use can't be deleted: a dialog asks the editor to take it
 * off those pages first and lists them, each one opening in the site editor.
 * An unused name is deleted from the draft at once, with an Undo. While the
 * uses are still being read, Delete waits instead of guessing.
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
import { planNamedRuleDelete } from "./named-rule-edits";
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
  /** The uses aren't read yet. */
  | { kind: "loading" }
  /** Pages still use it: these, one row per block and variant. */
  | { kind: "in-use"; rows: NamedRuleUseRow[] }
  | { kind: "delete"; change: NamedRuleChange }
  /** Nothing to delete (the name is already gone). */
  | { kind: "none" };

/** What Delete does for `name` now. */
function planNamedRuleDeleteAction(input: {
  kind: NamedRuleKind;
  name: string;
  decofile: Record<string, unknown>;
  meta?: LiveMeta | null;
  uses: NamedRuleUses | null;
}): NamedRuleDeletePlan {
  const { kind, name, decofile, meta, uses } = input;
  if (!uses) return { kind: "loading" };
  const rows = namedRuleBlockingRows(uses, kind, name, decofile, meta);
  if (rows.length > 0) return { kind: "in-use", rows };
  const change = planNamedRuleDelete(decofile, kind, name);
  if (change) return { kind: "delete", change };
  const read = readNamedRuleBlock(decofile, kind);
  if (read.kind !== "saved" || !Object.hasOwn(read.block, name)) {
    return { kind: "none" };
  }
  // The uses were read from an older copy than the one held now: list the
  // pages from this one.
  const fresh = namedRuleUses({
    decofile,
    meta,
    changeCount: 0,
    sides: undefined,
  });
  return {
    kind: "in-use",
    rows: namedRuleBlockingRows(fresh, kind, name, decofile, meta),
  };
}

export function NamedRuleDeleteButton({
  kind,
  name,
  decofile,
  meta,
  uses,
  pending,
  apply,
  onDeleted,
  onUndo,
  onOpenUse,
}: {
  kind: NamedRuleKind;
  name: string;
  decofile: Record<string, unknown>;
  meta?: LiveMeta | null;
  uses: NamedRuleUses | null;
  /** A change is being saved. */
  pending: boolean;
  apply: (change: NamedRuleChange) => Promise<NamedRuleApplyOutcome>;
  /** The name left the draft. */
  onDeleted: () => void;
  /** Undo: puts the name back as it was. */
  onUndo: (change: NamedRuleChange) => void;
  onOpenUse: (row: NamedRuleUseRow) => void;
}) {
  const t = useT();
  const tests = kind === "experiments";
  const [blocking, setBlocking] = useState<NamedRuleUseRow[] | null>(null);
  const loading = !uses;

  const remove = async () => {
    const plan = planNamedRuleDeleteAction({
      kind,
      name,
      decofile,
      meta,
      uses,
    });
    if (plan.kind === "in-use") {
      setBlocking(plan.rows);
      return;
    }
    if (plan.kind !== "delete") return;
    const read = readNamedRuleBlock(decofile, kind);
    const value = read.kind === "saved" ? read.block[name] : undefined;
    const outcome = await apply(plan.change);
    if (!outcome.ok) return;
    onDeleted();
    const [blockKey, kept] = Object.entries(plan.change.writes)[0]!;
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
          onClick: () =>
            onUndo({ writes: { [blockKey]: { ...kept, [name]: value } } }),
        },
      },
    );
  };

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
                ? t("sectionsEditor.namedRuleDelete.inUseTestsHint", { name })
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

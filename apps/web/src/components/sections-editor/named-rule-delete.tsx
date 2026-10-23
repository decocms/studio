/**
 * Delete for a test (Experiments tab) or a campaign (Campaigns view). It is
 * never blocked: the name leaves the draft at once, with an Undo, and when
 * pages or sections still use it the toast says how many of each. Those then
 * show that the test or campaign isn't there (named-rule-uses.ts
 * `missingNamedRules`).
 *
 * Delete reads the draft as stored right now (another tab may have changed
 * it) and plans from that copy; Undo puts back only the deleted name onto
 * the block as it is then, so a test or campaign created since stays.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Trash01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { useT } from "@/i18n/use-t.ts";
import { planNamedRuleDelete, planNamedRuleRestore } from "./named-rule-edits";
import { namedRuleUseCounts } from "./named-rule-uses";
import { namedRuleUsePlaces } from "./named-rule-use-copy";
import { type NamedRuleKind, readNamedRuleBlock } from "./named-rules";
import type { LiveMeta } from "./resolve-schema";
import { SAVE_TOAST, SITE_EDITOR_UNDO_TOAST } from "./site-editor-toast";
import type {
  NamedRuleApplyOutcome,
  NamedRuleChange,
} from "./use-apply-named-rule";

export function NamedRuleDeleteButton({
  kind,
  name,
  meta,
  pending,
  apply,
  reread,
  onDeleted,
  onUndo,
}: {
  kind: NamedRuleKind;
  name: string;
  meta?: LiveMeta | null;
  /** A change is being saved. */
  pending: boolean;
  apply: (change: NamedRuleChange) => Promise<NamedRuleApplyOutcome>;
  /** The draft as stored right now; `null` when it can't be read. */
  reread: () => Promise<Record<string, unknown> | null>;
  /** The name left the draft. */
  onDeleted: () => void;
  /** Undo: writes the change that puts the name back. */
  onUndo: (change: NamedRuleChange) => void;
}) {
  const t = useT();
  const tests = kind === "experiments";
  const [checking, setChecking] = useState(false);

  /** The draft right now, or a calm toast and `null`. */
  const readNow = async () => {
    const fresh = await reread();
    if (!fresh) {
      toast.info(t("sectionsEditor.namedRules.unavailable"), {
        ...SAVE_TOAST,
        description: t("sectionsEditor.namedRules.unavailableHint"),
      });
    }
    return fresh;
  };

  const undo = async (raw: unknown) => {
    const fresh = await readNow();
    if (!fresh) return;
    const change = planNamedRuleRestore(fresh, kind, name, raw);
    if (change) {
      onUndo(change);
      return;
    }
    // The name is back already (created again since, here or in another
    // tab) or the block changed: say so, calmly, instead of doing nothing.
    const conflict = readNamedRuleBlock(fresh, kind).kind === "conflict";
    toast.info(
      conflict
        ? t("sectionsEditor.namedRules.changedMeanwhile")
        : t("sectionsEditor.namedRules.alreadyBack"),
      {
        ...SAVE_TOAST,
        description: conflict
          ? t("sectionsEditor.namedRules.changedMeanwhileHint")
          : t("sectionsEditor.namedRules.alreadyBackHint"),
      },
    );
  };

  const remove = async () => {
    setChecking(true);
    let fresh: Record<string, unknown> | null;
    try {
      fresh = await readNow();
    } finally {
      setChecking(false);
    }
    if (!fresh) return;
    const change = planNamedRuleDelete(fresh, kind, name);
    if (!change) return;
    const read = readNamedRuleBlock(fresh, kind);
    const raw = read.kind === "saved" ? read.block[name] : undefined;
    const used = namedRuleUsePlaces(
      t,
      namedRuleUseCounts(fresh, meta, kind, name),
    );
    const outcome = await apply(change);
    if (!outcome.ok) return;
    onDeleted();
    toast.success(
      tests
        ? t("experiments.v8.deleted", { name })
        : t("sandbox.dateCampaigns.deleted", { name }),
      {
        id: SITE_EDITOR_UNDO_TOAST,
        description: used?.one
          ? t("sectionsEditor.namedRuleDelete.stillUsedOne", {
              places: used.places,
            })
          : used
            ? t("sectionsEditor.namedRuleDelete.stillUsed", {
                places: used.places,
              })
            : tests
              ? t("experiments.v8.deletedHint")
              : t("sandbox.dateCampaigns.deletedHint"),
        action: {
          label: t("sectionsEditor.namedRules.undo"),
          onClick: () => void undo(raw),
        },
      },
    );
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={pending || checking}
      onClick={() => void remove()}
    >
      <Trash01 size={16} />
      {tests ? t("experiments.v8.delete") : t("sandbox.dateCampaigns.delete")}
    </Button>
  );
}

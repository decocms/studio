/**
 * Delete for a test (Experiments tab) or a campaign (Campaigns view). It is
 * never blocked: the name leaves the draft at once, with an Undo, and when
 * pages still use it the toast says how many. Those pages then show that the
 * test or campaign no longer exists (named-rule-uses.ts `missingNamedRules`).
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
import { namedRuleUseCount, namedRuleUses } from "./named-rule-uses";
import { type NamedRuleKind, readNamedRuleBlock } from "./named-rules";
import type { LiveMeta } from "./resolve-schema";
import { SITE_EDITOR_SAVE_TOAST } from "./site-editor-toast";
import type {
  NamedRuleApplyOutcome,
  NamedRuleChange,
} from "./use-apply-named-rule";

/** How many pages and sections use `name` in `decofile`. */
function pagesUsing(
  kind: NamedRuleKind,
  name: string,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): number {
  const uses = namedRuleUses({
    decofile,
    meta,
    changeCount: 0,
    sides: undefined,
  });
  return namedRuleUseCount(uses, kind, name);
}

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
    const count = pagesUsing(kind, name, fresh, meta);
    const outcome = await apply(change);
    if (!outcome.ok) return;
    onDeleted();
    toast.success(
      tests
        ? t("experiments.v8.deleted", { name })
        : t("sandbox.dateCampaigns.deleted", { name }),
      {
        id: SITE_EDITOR_SAVE_TOAST,
        description:
          count === 1
            ? t("sectionsEditor.namedRuleDelete.stillUsedOne")
            : count > 1
              ? t("sectionsEditor.namedRuleDelete.stillUsed", {
                  count: String(count),
                })
              : tests
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

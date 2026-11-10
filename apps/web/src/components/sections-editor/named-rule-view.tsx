/**
 * What the Experiments tab and the Calendar (campaigns) view share: both list
 * the names of one kind's block (named-rules.ts) from the draft, open one to
 * change it, create and delete, and write every change as one guarded
 * `blocks.apply` into the draft (use-apply-named-rule.ts). Each view keeps
 * its own frame, list and value editor (a share, a window); the rules, the
 * saves, the toasts and the sections around them live here, once.
 *
 * Neither view says where a name is used, nor renames one: Studio counts and
 * lists no uses, and a delete just deletes (`deco check` reports a rule that
 * names a missing test or campaign).
 */

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Badge } from "@decocms/ui/components/badge.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { type TFunction, useT } from "@/i18n/use-t.ts";
import {
  type NamedRuleEntryState,
  planNamedRuleCreate,
} from "./named-rule-edits";
import { NamedRuleDeleteButton } from "./named-rule-delete";
import type { NamedRulePick } from "./named-rule-picker";
import { nameProblemMessage, NamedRuleCreateForm } from "./named-rule-step";
import {
  type NamedRuleKind,
  namedRuleKindInfo,
  namedRuleSupport,
  readNamedRuleBlock,
} from "./named-rules";
import type { LiveMeta } from "./resolve-schema";
import { SAVE_TOAST, toastKeptTheirs } from "./site-editor-toast";
import {
  type NamedRuleApplyOutcome,
  type NamedRuleChange,
  useApplyNamedRule,
} from "./use-apply-named-rule";
import { usePublishedContent, usePublishedRead } from "./use-published-content";

/**
 * The copy that names the kind. In pt-br a test is masculine and a campaign
 * feminine, so these stay one key per kind.
 */
function namedRuleKindCopy(t: TFunction, kind: NamedRuleKind) {
  if (kind === "experiments") {
    return {
      new: t("experiments.v8.new"),
      stateNew: t("experiments.v8.state.new"),
      stateChanged: t("experiments.v8.state.changed"),
      removedTitle: t("experiments.v8.removedTitle"),
      removedHint: t("experiments.v8.removedHint"),
      created: (name: string) =>
        t("sectionsEditor.namedRulePicker.createdTest", { name }),
    };
  }
  return {
    new: t("sandbox.dateCampaigns.new"),
    stateNew: t("sandbox.dateCampaigns.state.new"),
    stateChanged: t("sandbox.dateCampaigns.state.changed"),
    removedTitle: t("sandbox.dateCampaigns.removedTitle"),
    removedHint: t("sandbox.dateCampaigns.removedHint"),
    created: (name: string) =>
      t("sectionsEditor.namedRulePicker.createdCampaign", { name }),
  };
}

/** Why the view can't list the kind: the site's schema, or a clashing block. */
export type NamedRuleViewBlocked = "missing" | "replaced" | "conflict";

export function namedRuleViewBlocked(
  decofile: Record<string, unknown>,
  meta: LiveMeta | null | undefined,
  kind: NamedRuleKind,
): NamedRuleViewBlocked | null {
  const support = namedRuleSupport(meta, kind);
  if (support !== "available") return support;
  return readNamedRuleBlock(decofile, kind).kind === "conflict"
    ? "conflict"
    : null;
}

/** One change into the draft; `false` when nothing was written. */
export type NamedRuleSave = (
  change: NamedRuleChange | null,
  title?: string,
) => Promise<boolean>;

/**
 * The state and actions of a kind's view: the published content it is
 * compared with, the open name, the create dialog, and `save`, which writes
 * one change with one toast.
 */
export function useNamedRuleView(
  kind: NamedRuleKind,
  input: {
    orgSlug: string;
    virtualMcpId: string;
    branch: string;
    decofile: Record<string, unknown>;
    meta: LiveMeta | null | undefined;
    /** The open name, when the caller keeps it (a URL); else kept here. */
    open?: { name: string | null; set: (name: string | null) => void };
  },
) {
  const t = useT();
  const { orgSlug, virtualMcpId, branch, decofile, meta } = input;
  const published = usePublishedContent({
    orgSlug,
    virtualMcpId,
    branch,
    decofile,
  });
  // The kind's block as it is live, never the draft's copy in its place:
  // what the Experiments app's "Live now" shows.
  const live = usePublishedRead({
    orgSlug,
    virtualMcpId,
    branch,
    decofile,
    blockKey: namedRuleKindInfo(kind).blockKey,
  });
  const { apply, reread, isPending, holdsCopy } = useApplyNamedRule({
    orgSlug,
    virtualMcpId,
    branch,
  });
  const [ownOpenName, setOwnOpenName] = useState<string | null>(null);
  const openName = input.open ? input.open.name : ownOpenName;
  const setOpenName = input.open ? input.open.set : setOwnOpenName;
  const [creating, setCreating] = useState(false);

  const save: NamedRuleSave = async (
    change,
    title = t("sectionsEditor.namedRules.saved"),
  ) => {
    if (!change) return false;
    const outcome = await apply(change);
    // The user took their version: say that, not "Saved".
    if (outcome.ok && outcome.keptTheirs) toastKeptTheirs(t, false);
    else if (outcome.ok) {
      toast.success(title, {
        ...SAVE_TOAST,
        description: t("sectionsEditor.namedRules.savedHint"),
      });
    }
    return outcome.ok;
  };

  /** The create dialog's submit: saved, closed, and the new name opened. */
  const create = (pick: NamedRulePick) => {
    if (pick.kind !== kind || !pick.create) return;
    const value =
      pick.kind === "experiments" ? pick.create.share : pick.create.window;
    const plan = planNamedRuleCreate(decofile, kind, pick.name, value!);
    if (!("change" in plan)) {
      // The form checks the name first, so this is a draft that changed
      // meanwhile: say so instead of leaving the dialog unanswered.
      toast.info(
        plan.problem === "conflict"
          ? t("sectionsEditor.namedRules.changedMeanwhile")
          : nameProblemMessage(t, plan.problem),
        SAVE_TOAST,
      );
      return;
    }
    const name = pick.name.trim();
    void save(plan.change, namedRuleKindCopy(t, kind).created(name)).then(
      (ok) => {
        if (ok) {
          setCreating(false);
          setOpenName(name);
        }
      },
    );
  };

  return {
    /** The published content; `null` while it isn't known. */
    published,
    /** The kind's block as it is live, strictly (no draft fallback). */
    live,
    apply,
    reread,
    isPending,
    holdsCopy,
    openName,
    setOpenName,
    creating,
    setCreating,
    blocked: namedRuleViewBlocked(decofile, meta, kind),
    save,
    create,
    /** Undo of a delete writes the change that puts the name back. */
    undo: (change: NamedRuleChange) => void save(change),
  };
}

/** The create dialog of a view: the rule picker's create form, on its own. */
export function NamedRuleCreateDialog({
  kind,
  open,
  onOpenChange,
  existingNames,
  pending,
  onCreate,
}: {
  kind: NamedRuleKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingNames: string[];
  pending: boolean;
  onCreate: (pick: NamedRulePick) => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 sm:max-w-md">
        <DialogTitle className="sr-only">
          {namedRuleKindCopy(t, kind).new}
        </DialogTitle>
        <NamedRuleCreateForm
          kind={kind}
          initialName=""
          existingNames={existingNames}
          pending={pending}
          submitLabel={t("sectionsEditor.namedRules.create")}
          dismiss="cancel"
          standalone
          onBack={() => onOpenChange(false)}
          onSubmit={onCreate}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Under the list: the names the draft removed (they stop at the next Publish). */
export function NamedRuleDraftNotes({
  kind,
  removed,
}: {
  kind: NamedRuleKind;
  removed: string[];
}) {
  const t = useT();
  const copy = namedRuleKindCopy(t, kind);
  if (removed.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{copy.removedTitle}</h3>
      <p className="text-xs text-muted-foreground">{copy.removedHint}</p>
      <ul className="text-sm text-muted-foreground">
        {removed.map((name) => (
          <li key={name} className="line-through">
            {name}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Not published yet" / "Changed in your draft"; `changed` only in lists. */
export function NamedRuleEntryBadge({
  kind,
  state,
  changed = true,
}: {
  kind: NamedRuleKind;
  state: NamedRuleEntryState | null;
  changed?: boolean;
}) {
  const t = useT();
  const copy = namedRuleKindCopy(t, kind);
  if (state === "new") return <Badge variant="muted">{copy.stateNew}</Badge>;
  if (state === "changed" && changed) {
    return <Badge variant="muted">{copy.stateChanged}</Badge>;
  }
  return null;
}

/** What an opened name's detail gets from its view. */
export interface NamedRuleDetailProps<Row extends { name: string }> {
  row: Row;
  decofile: Record<string, unknown>;
  meta: LiveMeta | null | undefined;
  pending: boolean;
  /**
   * The detail keeps the copy it shows and builds its changes on it
   * (`NamedRuleChange.basis`, hosted v8): an untouched form follows the
   * draft, and a save of an older copy is reconciled, never written over.
   */
  holdsCopy: boolean;
  onBack: () => void;
  onSave: NamedRuleSave;
  apply: (change: NamedRuleChange) => Promise<NamedRuleApplyOutcome>;
  /** The draft as stored now, what a delete and its Undo plan from. */
  reread: () => Promise<Record<string, unknown> | null>;
  onDeleted: () => void;
  onUndo: (change: NamedRuleChange) => void;
}

/** The detail's heading: the name, its status and whether it's published. */
export function NamedRuleDetailTitle({
  kind,
  name,
  status,
  entryState,
}: {
  kind: NamedRuleKind;
  name: string;
  status: ReactNode;
  entryState: NamedRuleEntryState | null;
}) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="text-lg font-semibold">{name}</h2>
      {status}
      <NamedRuleEntryBadge kind={kind} state={entryState} changed={false} />
    </div>
  );
}

/** The detail's Delete: it just deletes, with an Undo (named-rule-delete.tsx). */
export function NamedRuleDetailDelete({
  kind,
  detail,
}: {
  kind: NamedRuleKind;
  detail: NamedRuleDetailProps<{ name: string }>;
}) {
  return (
    <NamedRuleDeleteButton
      kind={kind}
      name={detail.row.name}
      pending={detail.pending}
      apply={detail.apply}
      reread={detail.reread}
      onDeleted={detail.onDeleted}
      onUndo={detail.onUndo}
    />
  );
}

/** The detail's props from the view's state, for the opened `row`. */
export function namedRuleDetailProps<Row extends { name: string }>(
  view: ReturnType<typeof useNamedRuleView>,
  row: Row,
  input: {
    decofile: Record<string, unknown>;
    meta: LiveMeta | null | undefined;
  },
): NamedRuleDetailProps<Row> {
  return {
    row,
    decofile: input.decofile,
    meta: input.meta,
    pending: view.isPending,
    holdsCopy: view.holdsCopy,
    onBack: () => view.setOpenName(null),
    onSave: view.save,
    apply: view.apply,
    reread: view.reread,
    onDeleted: () => view.setOpenName(null),
    onUndo: view.undo,
  };
}

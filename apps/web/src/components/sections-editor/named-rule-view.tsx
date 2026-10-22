/**
 * What the Experiments tab and the Calendar (campaigns) view share: both list
 * the names of one kind's block (named-rules.ts) from the draft, open one to
 * change it, create, rename and delete, and write every change as one guarded
 * `blocks.apply` into the draft (use-apply-named-rule.ts). Each view keeps
 * its own frame, list and value editor (a share, a window); the rules, the
 * saves, the toasts and the sections around them live here, once.
 */

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { type TFunction, useT } from "@/i18n/use-t.ts";
import {
  type NamedRuleEntryState,
  planNamedRuleCreate,
} from "./named-rule-edits";
import { NamedRuleDeleteButton } from "./named-rule-delete";
import { type NamedRulePick, newNameProblem } from "./named-rule-picker";
import { nameProblemMessage, NamedRuleCreateForm } from "./named-rule-step";
import { MissingNamedRuleUses } from "./named-rule-used-by";
import {
  missingNamedRuleRowNames,
  missingNamedRuleRows,
  type NamedRuleUseRow,
  type NamedRuleUses,
  namedRuleUseRows,
} from "./named-rule-uses";
import {
  type NamedRuleKind,
  namedRuleNames,
  namedRuleSupport,
  readNamedRuleBlock,
} from "./named-rules";
import type { LiveMeta } from "./resolve-schema";
import { planNamedRuleRename } from "./rule-references";
import { SITE_EDITOR_SAVE_TOAST } from "./site-editor-toast";
import {
  type NamedRuleApplyOutcome,
  type NamedRuleChange,
  useApplyNamedRule,
} from "./use-apply-named-rule";
import { useNamedRuleUses } from "./use-named-rule-uses";

/**
 * The copy that names the kind. In pt-br a test is masculine and a campaign
 * feminine, so these stay one key per kind.
 */
export function namedRuleKindCopy(t: TFunction, kind: NamedRuleKind) {
  if (kind === "experiments") {
    return {
      new: t("experiments.v8.new"),
      usedBy: (count: number) =>
        t("experiments.v8.usedBy", { count: String(count) }),
      notUsed: t("experiments.v8.notUsed"),
      stateNew: t("experiments.v8.state.new"),
      stateChanged: t("experiments.v8.state.changed"),
      removedTitle: t("experiments.v8.removedTitle"),
      removedHint: t("experiments.v8.removedHint"),
      created: (name: string) =>
        t("sectionsEditor.namedRulePicker.createdTest", { name }),
      renamed: (name: string) => t("experiments.v8.renamed", { name }),
      renameHint: t("experiments.v8.renameHint"),
      renameWholeHint: t("experiments.v8.renameWholeHint"),
    };
  }
  return {
    new: t("sandbox.dateCampaigns.new"),
    usedBy: (count: number) =>
      t("sandbox.dateCampaigns.usedBy", { count: String(count) }),
    notUsed: t("sandbox.dateCampaigns.notUsed"),
    stateNew: t("sandbox.dateCampaigns.state.new"),
    stateChanged: t("sandbox.dateCampaigns.state.changed"),
    removedTitle: t("sandbox.dateCampaigns.removedTitle"),
    removedHint: t("sandbox.dateCampaigns.removedHint"),
    created: (name: string) =>
      t("sectionsEditor.namedRulePicker.createdCampaign", { name }),
    renamed: (name: string) => t("sandbox.dateCampaigns.renamed", { name }),
    renameHint: t("sandbox.dateCampaigns.renameHint"),
    renameWholeHint: t("sandbox.dateCampaigns.renameWholeHint"),
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
 * The state and actions of a kind's view: where it's used, the open name,
 * the create dialog, and `save`, which writes one change with one toast.
 */
export function useNamedRuleView(
  kind: NamedRuleKind,
  input: {
    orgSlug: string;
    virtualMcpId: string;
    branch: string;
    decofile: Record<string, unknown>;
    meta: LiveMeta | null | undefined;
  },
) {
  const t = useT();
  const { orgSlug, virtualMcpId, branch, decofile, meta } = input;
  const uses = useNamedRuleUses({
    orgSlug,
    virtualMcpId,
    branch,
    decofile,
    meta,
  });
  const { apply, reread, planStored, isPending } = useApplyNamedRule({
    orgSlug,
    virtualMcpId,
    branch,
  });
  const [openName, setOpenName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const save: NamedRuleSave = async (
    change,
    title = t("sectionsEditor.namedRules.saved"),
  ) => {
    if (!change) return false;
    const outcome = await apply(change);
    if (outcome.ok) {
      toast.success(title, {
        id: SITE_EDITOR_SAVE_TOAST,
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
        { id: SITE_EDITOR_SAVE_TOAST },
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
    uses,
    apply,
    reread,
    planStored,
    isPending,
    openName,
    setOpenName,
    creating,
    setCreating,
    blocked: namedRuleViewBlocked(decofile, meta, kind),
    missing: uses ? missingNamedRuleRows(uses, kind, decofile, meta) : [],
    missingNames: uses
      ? missingNamedRuleRowNames(uses, kind, decofile, meta)
      : 0,
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

/**
 * Under the list: pages that use a name that isn't there, and the names the
 * draft removed (they stop at the next Publish).
 */
export function NamedRuleDraftNotes({
  kind,
  missing,
  missingNames,
  removed,
  onOpenUse,
}: {
  kind: NamedRuleKind;
  missing: NamedRuleUseRow[];
  missingNames: number;
  removed: string[];
  onOpenUse: (row: NamedRuleUseRow) => void;
}) {
  const t = useT();
  const copy = namedRuleKindCopy(t, kind);
  return (
    <>
      <MissingNamedRuleUses
        kind={kind}
        rows={missing}
        names={missingNames}
        onOpen={onOpenUse}
      />
      {removed.length > 0 && (
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
      )}
    </>
  );
}

/** A row's "Used by 2" / "Not used yet". */
export function namedRuleUsesLabel(
  t: TFunction,
  kind: NamedRuleKind,
  uses: number,
): string {
  const copy = namedRuleKindCopy(t, kind);
  return uses > 0 ? copy.usedBy(uses) : copy.notUsed;
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
  uses: NamedRuleUses | null;
  pending: boolean;
  onBack: () => void;
  onOpenUse: (row: NamedRuleUseRow) => void;
  onSave: NamedRuleSave;
  onRenamed: (name: string) => void;
  apply: (change: NamedRuleChange) => Promise<NamedRuleApplyOutcome>;
  reread: () => Promise<Record<string, unknown> | null>;
  /** Plans a rename from the draft as stored now (use-apply-named-rule.ts). */
  planStored: (
    plan: (decofile: Record<string, unknown>) => NamedRuleChange | null,
  ) => Promise<NamedRuleChange | null>;
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

/** The detail's Delete, never blocked, with an Undo (named-rule-delete.tsx). */
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
      meta={detail.meta}
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
    onOpenUse: (row: NamedRuleUseRow) => void;
  },
): NamedRuleDetailProps<Row> {
  return {
    row,
    decofile: input.decofile,
    meta: input.meta,
    uses: view.uses,
    pending: view.isPending,
    onBack: () => view.setOpenName(null),
    onOpenUse: input.onOpenUse,
    onSave: view.save,
    onRenamed: view.setOpenName,
    apply: view.apply,
    reread: view.reread,
    planStored: view.planStored,
    onDeleted: () => view.setOpenName(null),
    onUndo: view.undo,
  };
}

/** Where an opened name is used: by name, and sections that read every one. */
export function namedRuleDetailUses(
  kind: NamedRuleKind,
  name: string,
  uses: NamedRuleUses | null,
  decofile: Record<string, unknown>,
  meta: LiveMeta | null | undefined,
) {
  return {
    useRows: uses ? namedRuleUseRows(uses, kind, name, decofile, meta) : [],
    wholeRows: uses ? namedRuleUseRows(uses, kind, null, decofile, meta) : [],
  };
}

/**
 * The rename of an opened name: the typed name, why it can't be used, and
 * `rename`, planned from the draft as stored now so every use gets the new
 * name. A name the block holds unreadable is taken too: renaming onto it
 * would lose that entry.
 */
export function useNamedRuleRename(
  kind: NamedRuleKind,
  props: Pick<
    NamedRuleDetailProps<{ name: string }>,
    "row" | "decofile" | "meta" | "planStored" | "onSave" | "onRenamed"
  >,
) {
  const t = useT();
  const current = props.row.name;
  const [name, setName] = useState(current);
  const unchanged = name.trim() === current;
  const others = namedRuleNames(
    readNamedRuleBlock(props.decofile, kind),
  ).filter((key) => key !== current);
  const problem = unchanged ? null : newNameProblem(name, others);

  const rename = async () => {
    const next = name.trim();
    if (problem || next === current) return;
    const plan = await props.planStored((stored) =>
      planNamedRuleRename(stored, kind, current, next, props.meta),
    );
    if (
      plan &&
      (await props.onSave(plan, namedRuleKindCopy(t, kind).renamed(next)))
    ) {
      props.onRenamed(next);
    }
  };

  return {
    /** The saved name, shown read-only while the name is locked. */
    savedName: current,
    name,
    setName,
    message: problem ? nameProblemMessage(t, problem) : null,
    blocked: !!problem || unchanged,
    rename,
  };
}

/**
 * The detail's name section: the name with Rename, or, when `locked` says
 * why, the name read-only. Sections that read every name in their own code
 * aren't rewritten by a rename, so the hint says to update them.
 */
export function NamedRuleRenameSection({
  kind,
  id,
  rename,
  pending,
  wholeUses,
  locked,
}: {
  kind: NamedRuleKind;
  /** The name input's id. */
  id: string;
  rename: ReturnType<typeof useNamedRuleRename>;
  pending: boolean;
  /** Sections that read the whole block. */
  wholeUses: number;
  /** Why the name can't change now; the input is read-only then. */
  locked?: ReactNode;
}) {
  const t = useT();
  const copy = namedRuleKindCopy(t, kind);
  return (
    <section className="flex flex-col gap-2">
      <Label htmlFor={id}>{t("sectionsEditor.namedRules.nameLabel")}</Label>
      {locked ? (
        <>
          <Input
            id={id}
            className="max-w-xs"
            value={rename.savedName}
            readOnly
            disabled
          />
          {locked}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Input
              id={id}
              className="max-w-xs"
              value={rename.name}
              onChange={(e) => rename.setName(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={pending || rename.blocked}
              onClick={() => void rename.rename()}
            >
              {t("sectionsEditor.namedRules.rename")}
            </Button>
          </div>
          {rename.message && (
            <p className="text-xs text-destructive">{rename.message}</p>
          )}
          <p className="text-xs text-muted-foreground">{copy.renameHint}</p>
          {wholeUses > 0 && (
            <p className="text-xs text-muted-foreground">
              {copy.renameWholeHint}
            </p>
          )}
        </>
      )}
    </section>
  );
}

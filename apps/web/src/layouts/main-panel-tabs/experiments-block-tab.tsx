/**
 * The Experiments tab of a Blocks (v8) site: its A/B tests are the saved
 * block `experiments` (type `split-traffic`, name → whole % of visitors in
 * the test), read and written in the draft the site editor works in. Every
 * change is one guarded `blocks.apply` into that draft and goes live with the
 * normal Publish; production is never written, and none of Studio's
 * experiment records, suggestions or agent tools are used here.
 *
 * A test's status comes from its share: 0 off, 100 everyone, anything
 * between running. A running test's name is locked (visitors are grouped by
 * it); renaming one that isn't running rewrites every rule that names it in
 * the same change. "Used by" lists the pages and sections that use it, with
 * the uses not published yet marked. Delete is never blocked; pages that
 * still use a test that isn't there are listed under the tests.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Beaker02, Plus } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ShareSplit } from "@/components/experiments/split-donut";
import { Page } from "@/components/page";
import { SiteDraftViewHeader } from "@/components/site-draft-bar/view-header";
import {
  planNamedRuleCreate,
  planNamedRuleSet,
} from "@/components/sections-editor/named-rule-edits";
import { NamedRuleDeleteButton } from "@/components/sections-editor/named-rule-delete";
import { newNameProblem } from "@/components/sections-editor/named-rule-picker";
import { NamedRuleCreateForm } from "@/components/sections-editor/named-rule-step";
import {
  MissingNamedRuleUses,
  NamedRuleUsedBy,
} from "@/components/sections-editor/named-rule-used-by";
import {
  missingNamedRuleRowNames,
  missingNamedRuleRows,
  type NamedRuleUseRow,
  type NamedRuleUses,
  namedRuleUseRows,
} from "@/components/sections-editor/named-rule-uses";
import {
  canRenameExperiment,
  type ExperimentStatus,
  namedRuleSupport,
  readNamedRuleBlock,
} from "@/components/sections-editor/named-rules";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { planNamedRuleRename } from "@/components/sections-editor/rule-references";
import { SITE_EDITOR_SAVE_TOAST } from "@/components/sections-editor/site-editor-toast";
import {
  type NamedRuleApplyOutcome,
  type NamedRuleChange,
  useApplyNamedRule,
} from "@/components/sections-editor/use-apply-named-rule";
import { useNamedRuleUses } from "@/components/sections-editor/use-named-rule-uses";
import { useT } from "@/i18n/use-t.ts";
import {
  type ExperimentRowModel,
  experimentRows,
  removedExperiments,
  contentSearchForUse,
} from "./experiments-v8-model";
import {
  SiteDraftGuide,
  type SiteDraftGuideAction,
  SiteDraftView,
  type SiteDraftViewReady,
} from "./site-draft-view";
import { usePanelNavigate } from "./use-panel-navigate";

/** While main's schema (or the site's content) is read: the tab's shape. */
export function ExperimentsTabSkeleton() {
  return (
    <Page>
      <Page.Content>
        <Page.Container>
          <div
            className="flex flex-col gap-3 py-2"
            data-testid="experiments-skeleton"
            aria-busy="true"
          >
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </Page.Container>
      </Page.Content>
    </Page>
  );
}

const STATUS_DOT: Record<ExperimentStatus, string> = {
  running: "bg-success",
  everyone: "bg-primary",
  off: "bg-muted-foreground/50",
};

function useStatusLabel() {
  const t = useT();
  return (status: ExperimentStatus) =>
    status === "running"
      ? t("experiments.v8.status.running")
      : status === "everyone"
        ? t("experiments.v8.status.everyone")
        : t("experiments.v8.status.off");
}

function StatusPill({ status }: { status: ExperimentStatus }) {
  const label = useStatusLabel();
  return (
    <Badge variant="secondary" data-status={status}>
      <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
      {label(status)}
    </Badge>
  );
}

function GuideState(props: {
  title: string;
  description: string;
  action?: SiteDraftGuideAction;
}) {
  return (
    <SiteDraftGuide
      icon={<Beaker02 size={28} className="text-muted-foreground" />}
      {...props}
    />
  );
}

export function ExperimentsBlockTab({
  virtualMcpId,
}: {
  virtualMcpId: string;
}) {
  const t = useT();
  return (
    <SiteDraftView
      virtualMcpId={virtualMcpId}
      icon={<Beaker02 size={28} className="text-muted-foreground" />}
      copy={{
        noDraftTitle: t("experiments.v8.noDraft.title"),
        noDraftDesc: t("experiments.v8.noDraft.desc"),
        openEditor: t("experiments.v8.openEditor"),
        loadFailed: t("experiments.v8.loadFailed"),
        loadFailedHint: t("sectionsEditor.namedRules.unavailableHint"),
        tryAgain: t("experiments.v8.tryAgain"),
      }}
      skeleton={<ExperimentsTabSkeleton />}
    >
      {(ready) => <ExperimentsBlockReady {...ready} />}
    </SiteDraftView>
  );
}

function ExperimentsBlockReady({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  meta,
}: SiteDraftViewReady) {
  const t = useT();
  const { openPanel } = usePanelNavigate();
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

  const support = namedRuleSupport(meta, "experiments");
  if (support === "missing") {
    return (
      <GuideState
        title={t("experiments.v8.missing.title")}
        description={t("experiments.v8.missing.desc")}
      />
    );
  }
  if (support === "replaced") {
    return (
      <GuideState
        title={t("experiments.v8.replaced.title")}
        description={t("experiments.v8.replaced.desc")}
      />
    );
  }
  if (readNamedRuleBlock(decofile, "experiments").kind === "conflict") {
    return (
      <GuideState
        title={t("experiments.v8.conflict.title")}
        description={t("experiments.v8.conflict.desc")}
        action={{
          label: t("experiments.v8.openEditor"),
          onClick: () => openPanel("content"),
        }}
      />
    );
  }

  const rows = experimentRows(decofile, uses);
  const removed = removedExperiments(decofile, uses);
  const missing = uses
    ? missingNamedRuleRows(uses, "experiments", decofile, meta)
    : [];
  const missingNames = uses
    ? missingNamedRuleRowNames(uses, "experiments", decofile, meta)
    : 0;

  /** One change into the draft, with one toast for it. */
  const save = async (
    change: NamedRuleChange | null,
    toastTitle = t("experiments.v8.saved"),
  ) => {
    if (!change) return false;
    const outcome = await apply(change);
    if (outcome.ok) {
      toast.success(toastTitle, {
        id: SITE_EDITOR_SAVE_TOAST,
        description: t("experiments.v8.savedHint"),
      });
    }
    return outcome.ok;
  };

  const openUse = (row: NamedRuleUseRow) =>
    openPanel("content", {
      search: (prev) => ({ ...prev, ...contentSearchForUse(row) }),
    });

  const opened = rows.find((row) => row.name === openName) ?? null;
  if (opened) {
    return (
      <ExperimentBlockDetail
        key={opened.name}
        row={opened}
        decofile={decofile}
        meta={meta}
        uses={uses}
        pending={isPending}
        onBack={() => setOpenName(null)}
        onOpenUse={openUse}
        onSave={save}
        onRenamed={setOpenName}
        apply={apply}
        reread={reread}
        planStored={planStored}
        onDeleted={() => setOpenName(null)}
        onUndo={(change) => void save(change)}
      />
    );
  }

  return (
    <Page>
      <SiteDraftViewHeader
        title={t("experiments.title")}
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={16} />
            {t("experiments.v8.new")}
          </Button>
        }
      />
      <Page.Content>
        <Page.Container>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {t("experiments.v8.intro")}
            </p>
            {rows.length === 0 ? (
              <EmptyState
                title={t("experiments.v8.empty.title")}
                description={t("experiments.v8.empty.desc")}
                buttonProps={{
                  children: t("experiments.v8.new"),
                  onClick: () => setCreating(true),
                }}
              />
            ) : (
              <Card
                className="gap-0 divide-y divide-border overflow-hidden"
                data-testid="experiments-v8-list"
              >
                {rows.map((row) => (
                  <ExperimentBlockRow
                    key={row.name}
                    row={row}
                    onOpen={() => setOpenName(row.name)}
                  />
                ))}
              </Card>
            )}
            <MissingNamedRuleUses
              kind="experiments"
              rows={missing}
              names={missingNames}
              onOpen={openUse}
            />
            {removed.length > 0 && (
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-medium">
                  {t("experiments.v8.removedTitle")}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {t("experiments.v8.removedHint")}
                </p>
                <ul className="text-sm text-muted-foreground">
                  {removed.map((name) => (
                    <li key={name} className="line-through">
                      {name}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {t("experiments.v8.previewHint")}
            </p>
          </div>
        </Page.Container>
      </Page.Content>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="p-0 sm:max-w-md">
          <DialogTitle className="sr-only">
            {t("experiments.v8.new")}
          </DialogTitle>
          <NamedRuleCreateForm
            kind="experiments"
            initialName=""
            existingNames={rows.map((row) => row.name)}
            pending={isPending}
            submitLabel={t("experiments.v8.create")}
            dismiss="cancel"
            onBack={() => setCreating(false)}
            onSubmit={(pick) => {
              if (pick.kind !== "experiments" || !pick.create) return;
              const plan = planNamedRuleCreate(
                decofile,
                "experiments",
                pick.name,
                pick.create.share,
              );
              if (!("change" in plan)) return;
              void save(
                plan.change,
                t("experiments.v8.created", { name: pick.name }),
              ).then((ok) => {
                if (ok) {
                  setCreating(false);
                  setOpenName(pick.name);
                }
              });
            }}
          />
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function ExperimentBlockRow({
  row,
  onOpen,
}: {
  row: ExperimentRowModel;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <div
      className="group relative flex items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/50"
      data-testid="experiment-v8-row"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <button
          type="button"
          onClick={onOpen}
          className="truncate text-left text-sm font-medium text-foreground after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
        >
          {row.name}
        </button>
        <span className="truncate text-xs text-muted-foreground">
          {row.uses > 0
            ? t("experiments.v8.usedBy", { count: String(row.uses) })
            : t("experiments.v8.notUsed")}
        </span>
      </div>
      <span className="w-32 shrink-0 text-xs tabular-nums text-muted-foreground">
        {t("experiments.v8.share", { share: String(row.share) })}
      </span>
      <div className="hidden w-40 shrink-0 md:flex">
        {row.entryState === "new" && (
          <Badge variant="muted">{t("experiments.v8.state.new")}</Badge>
        )}
        {row.entryState === "changed" && (
          <Badge variant="muted">{t("experiments.v8.state.changed")}</Badge>
        )}
      </div>
      <div className="flex w-24 shrink-0">
        <StatusPill status={row.status} />
      </div>
    </div>
  );
}

function ExperimentBlockDetail({
  row,
  decofile,
  meta,
  uses,
  pending,
  onBack,
  onOpenUse,
  onSave,
  onRenamed,
  apply,
  reread,
  planStored,
  onDeleted,
  onUndo,
}: {
  row: ExperimentRowModel;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  uses: NamedRuleUses | null;
  pending: boolean;
  onBack: () => void;
  onOpenUse: (row: NamedRuleUseRow) => void;
  onSave: (change: NamedRuleChange | null) => Promise<boolean>;
  onRenamed: (name: string) => void;
  apply: (change: NamedRuleChange) => Promise<NamedRuleApplyOutcome>;
  reread: () => Promise<Record<string, unknown> | null>;
  /** Plans a rename from the draft as stored now (use-apply-named-rule.ts). */
  planStored: (
    plan: (decofile: Record<string, unknown>) => NamedRuleChange | null,
  ) => Promise<NamedRuleChange | null>;
  onDeleted: () => void;
  onUndo: (change: NamedRuleChange) => void;
}) {
  const t = useT();
  const [share, setShare] = useState(row.share);
  const [name, setName] = useState(row.name);
  const shareDirty = share !== row.share;
  const renamable = canRenameExperiment(row.share);
  const block = readNamedRuleBlock(decofile, "experiments");
  const others =
    block.kind === "conflict"
      ? []
      : Object.keys(block.block).filter(
          (key) => key !== "__resolveType" && key !== row.name,
        );
  const nameProblem =
    name.trim() === row.name ? null : newNameProblem(name, others);
  const nameMessage =
    nameProblem === "empty"
      ? t("experiments.v8.nameEmpty")
      : nameProblem === "taken"
        ? t("experiments.v8.nameTaken")
        : nameProblem === "reserved"
          ? t("experiments.v8.nameReserved")
          : null;

  const setTo = (value: number) =>
    void onSave(
      planNamedRuleSet(decofile, "experiments", row.name, value),
    ).then((ok) => ok && setShare(value));

  /** Planned from the draft as stored now, so every use gets the new name. */
  const rename = async () => {
    const next = name.trim();
    if (nameProblem || next === row.name) return;
    const plan = await planStored((stored) =>
      planNamedRuleRename(stored, "experiments", row.name, next, meta),
    );
    if (plan && (await onSave(plan))) onRenamed(next);
  };

  const useRows = uses
    ? namedRuleUseRows(uses, "experiments", row.name, decofile, meta)
    : [];
  const wholeRows = uses
    ? namedRuleUseRows(uses, "experiments", null, decofile, meta)
    : [];

  return (
    <Page>
      <Page.Breadcrumbs
        after="page"
        parent={{ label: t("experiments.title"), onSelect: onBack }}
        items={[{ key: "experiment", label: row.name }]}
      />
      <SiteDraftViewHeader
        back={{ label: t("experiments.v8.allTests"), onClick: onBack }}
        actions={
          <NamedRuleDeleteButton
            kind="experiments"
            name={row.name}
            meta={meta}
            pending={pending}
            apply={apply}
            reread={reread}
            onDeleted={onDeleted}
            onUndo={onUndo}
          />
        }
      />
      <Page.Content>
        <Page.Container>
          <div className="flex max-w-2xl flex-col gap-6">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold">{row.name}</h2>
              <StatusPill status={row.status} />
              {row.entryState === "new" && (
                <Badge variant="muted">{t("experiments.v8.state.new")}</Badge>
              )}
            </div>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">
                {t("experiments.v8.shareTitle")}
              </h3>
              <ShareSplit
                value={share}
                onChange={setShare}
                sliderLabel={t("experiments.v8.shareLabel")}
                inTestLabel={t("experiments.v8.split.inTest")}
                restLabel={t("experiments.v8.split.rest")}
                centerLabel={t("experiments.v8.split.center")}
                disabled={pending}
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={!shareDirty || pending}
                  onClick={() => setTo(share)}
                >
                  {t("experiments.v8.save")}
                </Button>
                {shareDirty && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setShare(row.share)}
                  >
                    {t("experiments.v8.split.reset", {
                      share: String(row.share),
                    })}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("experiments.v8.shareHint")}
              </p>
              {row.publishedShare !== undefined && (
                <p className="text-xs text-muted-foreground">
                  {t("experiments.v8.publishedShare", {
                    share: String(row.publishedShare),
                  })}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || row.share === 0}
                  onClick={() => setTo(0)}
                >
                  {t("experiments.v8.turnOff")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || row.share === 100}
                  onClick={() => setTo(100)}
                >
                  {t("experiments.v8.showEveryone")}
                </Button>
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <Label htmlFor="experiment-name">
                {t("experiments.v8.nameLabel")}
              </Label>
              {renamable ? (
                <>
                  <div className="flex items-center gap-2">
                    <Input
                      id="experiment-name"
                      className="max-w-xs"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        pending || !!nameProblem || name.trim() === row.name
                      }
                      onClick={() => void rename()}
                    >
                      {t("experiments.v8.rename")}
                    </Button>
                  </div>
                  {nameMessage && (
                    <p className="text-xs text-destructive">{nameMessage}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t("experiments.v8.renameHint")}
                  </p>
                </>
              ) : (
                <>
                  <Input
                    id="experiment-name"
                    className="max-w-xs"
                    value={row.name}
                    readOnly
                    disabled
                  />
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="experiment-name-locked"
                  >
                    {t("experiments.v8.nameLocked")}
                  </p>
                </>
              )}
            </section>

            <NamedRuleUsedBy
              kind="experiments"
              rows={useRows}
              wholeRows={wholeRows}
              loading={!uses}
              marked={!!uses?.published}
              onOpen={onOpenUse}
            />
          </div>
        </Page.Container>
      </Page.Content>
    </Page>
  );
}

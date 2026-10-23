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
import { Beaker02, Plus } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ShareSplit } from "@/components/experiments/split-donut";
import { Page } from "@/components/page";
import { SiteDraftViewHeader } from "@/components/site-draft-bar/view-header";
import { planNamedRuleSet } from "@/components/sections-editor/named-rule-edits";
import { NamedRuleUsedBy } from "@/components/sections-editor/named-rule-used-by";
import type { NamedRuleUseRow } from "@/components/sections-editor/named-rule-uses";
import {
  NamedRuleCreateDialog,
  NamedRuleDetailDelete,
  type NamedRuleDetailProps,
  NamedRuleDetailTitle,
  NamedRuleDraftNotes,
  NamedRuleEntryBadge,
  NamedRuleRenameSection,
  namedRuleDetailProps,
  namedRuleDetailUses,
  namedRuleUsesLabel,
  useNamedRuleRename,
  useNamedRuleView,
} from "@/components/sections-editor/named-rule-view";
import {
  canRenameExperiment,
  type ExperimentStatus,
} from "@/components/sections-editor/named-rules";
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

        loadFailed: t("experiments.v8.loadFailed"),
        loadFailedHint: t("sectionsEditor.namedRules.unavailableHint"),
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
  const view = useNamedRuleView("experiments", {
    orgSlug,
    virtualMcpId,
    branch,
    decofile,
    meta,
  });

  if (view.blocked === "missing") {
    return (
      <GuideState
        title={t("experiments.v8.missing.title")}
        description={t("experiments.v8.missing.desc")}
      />
    );
  }
  if (view.blocked === "replaced") {
    return (
      <GuideState
        title={t("experiments.v8.replaced.title")}
        description={t("experiments.v8.replaced.desc")}
      />
    );
  }
  if (view.blocked === "conflict") {
    return (
      <GuideState
        title={t("experiments.v8.conflict.title")}
        description={t("experiments.v8.conflict.desc")}
        action={{
          label: t("sectionsEditor.namedRules.openEditor"),
          onClick: () => openPanel("content"),
        }}
      />
    );
  }

  const rows = experimentRows(decofile, view.uses);
  const removed = removedExperiments(decofile, view.uses);

  const openUse = (row: NamedRuleUseRow) =>
    openPanel("content", {
      search: (prev) => ({ ...prev, ...contentSearchForUse(row) }),
    });

  const opened = rows.find((row) => row.name === view.openName) ?? null;
  if (opened) {
    return (
      <ExperimentBlockDetail
        key={opened.name}
        {...namedRuleDetailProps(view, opened, {
          decofile,
          meta,
          onOpenUse: openUse,
        })}
      />
    );
  }

  return (
    <Page>
      <SiteDraftViewHeader
        title={t("experiments.title")}
        actions={
          <Button size="sm" onClick={() => view.setCreating(true)}>
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
                  onClick: () => view.setCreating(true),
                }}
              />
            ) : (
              <Card
                size="flush"
                className="gap-0 divide-y divide-border overflow-hidden"
                data-testid="experiments-v8-list"
              >
                {rows.map((row) => (
                  <ExperimentBlockRow
                    key={row.name}
                    row={row}
                    onOpen={() => view.setOpenName(row.name)}
                  />
                ))}
              </Card>
            )}
            <NamedRuleDraftNotes
              kind="experiments"
              missing={view.missing}
              missingNames={view.missingNames}
              removed={removed}
              onOpenUse={openUse}
            />
            <p className="text-xs text-muted-foreground">
              {t("experiments.v8.previewHint")}
            </p>
          </div>
        </Page.Container>
      </Page.Content>
      <NamedRuleCreateDialog
        kind="experiments"
        open={view.creating}
        onOpenChange={view.setCreating}
        existingNames={rows.map((row) => row.name)}
        pending={view.isPending}
        onCreate={view.create}
      />
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
          {namedRuleUsesLabel(t, "experiments", row.uses)}
        </span>
      </div>
      <span className="w-32 shrink-0 text-xs tabular-nums text-muted-foreground">
        {t("sectionsEditor.namedRulePicker.shareOfVisitors", {
          share: String(row.share),
        })}
      </span>
      <div className="hidden w-40 shrink-0 md:flex">
        <NamedRuleEntryBadge kind="experiments" state={row.entryState} />
      </div>
      <div className="flex w-24 shrink-0">
        <StatusPill status={row.status} />
      </div>
    </div>
  );
}

function ExperimentBlockDetail(
  props: NamedRuleDetailProps<ExperimentRowModel>,
) {
  const { row, decofile, meta, uses, pending, onBack, onOpenUse, onSave } =
    props;
  const t = useT();
  const [share, setShare] = useState(row.share);
  const shareDirty = share !== row.share;
  const rename = useNamedRuleRename("experiments", props);

  const setTo = (value: number) =>
    void onSave(
      planNamedRuleSet(decofile, "experiments", row.name, value),
    ).then((ok) => ok && setShare(value));

  const { useRows, wholeRows } = namedRuleDetailUses(
    "experiments",
    row.name,
    uses,
    decofile,
    meta,
  );

  return (
    <Page>
      <Page.Breadcrumbs
        after="page"
        parent={{ label: t("experiments.title"), onSelect: onBack }}
        items={[{ key: "experiment", label: row.name }]}
      />
      <SiteDraftViewHeader
        back={{ label: t("experiments.v8.allTests"), onClick: onBack }}
        actions={<NamedRuleDetailDelete kind="experiments" detail={props} />}
      />
      <Page.Content>
        <Page.Container>
          <div className="flex max-w-2xl flex-col gap-6">
            <NamedRuleDetailTitle
              kind="experiments"
              name={row.name}
              status={<StatusPill status={row.status} />}
              entryState={row.entryState}
            />

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

            <NamedRuleRenameSection
              kind="experiments"
              id="experiment-name"
              rename={rename}
              pending={pending}
              wholeUses={wholeRows.length}
              locked={
                canRenameExperiment(row.share) ? undefined : (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="experiment-name-locked"
                  >
                    {t("experiments.v8.nameLocked")}
                  </p>
                )
              }
            />

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

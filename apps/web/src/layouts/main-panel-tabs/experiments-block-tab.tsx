/**
 * The Experiments tab of a Blocks (v8) site: its A/B tests are the saved
 * block `experiments` (type `split-traffic`, name → whole % of visitors in
 * the test), read and written in the draft the site editor works in. Every
 * change is one guarded `blocks.apply` into that draft and goes live with the
 * normal Publish; production is never written, and none of Studio's
 * experiment records, suggestions or agent tools are used here.
 *
 * A test's status comes from its share: 0 off, 100 everyone, anything
 * between running. The tab doesn't say where a test is used and doesn't
 * rename one; Delete just deletes, with an Undo (`deco check` reports a rule
 * that names a test that isn't there).
 */

import { type ReactNode, useEffect, useState } from "react";
import { Beaker02, ChevronRight, Plus } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  EXPERIMENT_STATUS_DOT,
  experimentStatusLabel,
} from "@/components/experiments/experiment-status-pill";
import {
  armColors,
  ShareSplit,
  SplitDonut,
  shareArms,
} from "@/components/experiments/split-donut";
import { Page } from "@/components/page";
import {
  SITE_DRAFT_VIEW_INSET,
  SiteDraftViewHeader,
} from "@/components/site-draft-bar/view-header";
import { planNamedRuleSet } from "@/components/sections-editor/named-rule-edits";
import {
  NamedRuleCreateDialog,
  NamedRuleDetailDelete,
  type NamedRuleDetailProps,
  NamedRuleDraftNotes,
  NamedRuleEntryBadge,
  namedRuleDetailProps,
  useNamedRuleView,
} from "@/components/sections-editor/named-rule-view";
import {
  copyScope,
  useCopyEpochs,
} from "@/components/sections-editor/held-copy";
import { namedRuleKindInfo } from "@/components/sections-editor/named-rules";
import type { PublishedRead } from "@/components/sections-editor/use-published-content";
import { useT } from "@/i18n/use-t.ts";
import {
  type ExperimentRowModel,
  experimentRows,
  removedExperiments,
} from "./experiments-v8-model";
import {
  SiteDraftGuide,
  type SiteDraftGuideAction,
  SiteDraftView,
  type SiteDraftViewReady,
} from "./site-draft-view";
import { usePanelNavigate } from "./use-panel-navigate";

/** While the site's content is read: the tab's shape. */
function ExperimentsTabSkeleton() {
  return (
    <Page>
      <Page.Content>
        <div
          className={cn("flex flex-col gap-3", SITE_DRAFT_VIEW_INSET)}
          data-testid="experiments-skeleton"
          aria-busy="true"
        >
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </Page.Content>
    </Page>
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

/** The test the tab shows, when its caller keeps it (the app's `?test=`). */
export interface ExperimentsOpenTest {
  name: string | null;
  set: (name: string | null) => void;
  /** Drops a name the draft doesn't have, in place. */
  clear?: () => void;
}

/** What the slot under the list gets: the draft, and what is published. */
export interface ExperimentsLiveSlotContext {
  orgSlug: string;
  virtualMcpId: string;
  draft: Record<string, unknown>;
  /** The `experiments` block as it is live (never the draft's copy). */
  published: PublishedRead;
  /** Opens a test of the draft in the editor above. */
  openTest: (name: string) => void;
}

export interface ExperimentsBlockTabProps {
  virtualMcpId: string;
  /** Left out, the tab keeps the open test itself. */
  open?: ExperimentsOpenTest;
  /** Rendered under the list (the app's "Live now"). */
  live?: (ctx: ExperimentsLiveSlotContext) => ReactNode;
}

export function ExperimentsBlockTab({
  virtualMcpId,
  open,
  live,
}: ExperimentsBlockTabProps) {
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
      {(ready) => <ExperimentsBlockReady {...ready} open={open} live={live} />}
    </SiteDraftView>
  );
}

export function ExperimentsBlockReady({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  meta,
  open,
  live,
}: SiteDraftViewReady & Pick<ExperimentsBlockTabProps, "open" | "live">) {
  const t = useT();
  const { openPanel } = usePanelNavigate();
  const view = useNamedRuleView("experiments", {
    orgSlug,
    virtualMcpId,
    branch,
    decofile,
    meta,
    open,
  });
  // A reconcile of the tests (hosted v8) replaced the copy the detail
  // shows: it shows the draft's copy again.
  const copyEpoch = useCopyEpochs(copyScope({ orgSlug, virtualMcpId, branch }))(
    EXPERIMENTS_BLOCK,
  );

  const rows = experimentRows(decofile, view.published);
  const opened = rows.find((row) => row.name === view.openName) ?? null;
  // A `?test=` the draft doesn't have (a live test the draft removed, an old
  // link): the list, without the name left in the URL.
  const unmatched = !view.blocked && view.openName !== null && !opened;
  const clearOpen = open?.clear;
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- syncs the URL (an external store) with the draft's names once they are known
  useEffect(() => {
    if (unmatched) clearOpen?.();
  }, [unmatched, clearOpen]);

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

  const removed = removedExperiments(decofile, view.published);
  const summary = experimentsSummary(t, rows);
  const empty = rows.length === 0;
  // With no test in the draft and none it removed, nothing is live either.
  const showLive = !empty || removed.length > 0;

  return (
    <Page>
      <SiteDraftViewHeader
        intro={t("experiments.v8.intro")}
        actions={
          empty ? undefined : (
            <Button size="sm" onClick={() => view.setCreating(true)}>
              <Plus size={16} />
              {t("experiments.v8.new")}
            </Button>
          )
        }
      />
      <Page.Content>
        <div className={cn("flex flex-col gap-4", SITE_DRAFT_VIEW_INSET)}>
          {empty ? (
            <EmptyState
              icon={<Beaker02 size={20} />}
              title={t("experiments.v8.empty.title")}
              description={t("experiments.v8.empty.desc")}
              className="rounded-xl border border-dashed border-border py-16"
              buttonProps={{
                children: (
                  <>
                    <Plus size={16} />
                    {t("experiments.v8.new")}
                  </>
                ),
                onClick: () => view.setCreating(true),
              }}
            />
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">{summary}</p>
              <Card
                size="flush"
                className="gap-0 divide-y divide-border overflow-hidden"
                data-testid="experiments-v8-list"
              >
                {rows.map((row) => {
                  const expanded = row.name === opened?.name;
                  return (
                    <ExperimentBlockRow
                      key={row.name}
                      row={row}
                      expanded={expanded}
                      onToggle={() =>
                        view.setOpenName(expanded ? null : row.name)
                      }
                    >
                      {expanded && (
                        <ExperimentBlockDetail
                          key={`${row.name}:${copyEpoch}`}
                          {...namedRuleDetailProps(view, row, {
                            decofile,
                            meta,
                          })}
                        />
                      )}
                    </ExperimentBlockRow>
                  );
                })}
              </Card>
            </div>
          )}
          <NamedRuleDraftNotes kind="experiments" removed={removed} />
          {!empty && (
            <p className="text-xs text-muted-foreground">
              {t("experiments.v8.previewHint")}
            </p>
          )}
          {showLive &&
            live?.({
              orgSlug,
              virtualMcpId,
              draft: decofile,
              published: view.live,
              openTest: (name) => view.setOpenName(name),
            })}
        </div>
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

/** "2 running · 1 off": how many tests are in each status, busiest first. */
function experimentsSummary(
  t: ReturnType<typeof useT>,
  rows: ExperimentRowModel[],
): string {
  const count = (status: ExperimentRowModel["status"]) =>
    rows.filter((row) => row.status === status).length;
  const running = count("running");
  const everyone = count("everyone");
  const off = count("off");
  return [
    running > 0 &&
      t("experiments.v8.count.running", { count: String(running) }),
    everyone > 0 &&
      t("experiments.v8.count.everyone", { count: String(everyone) }),
    off === 1 && t("experiments.v8.count.offOne"),
    off > 1 && t("experiments.v8.count.offMany", { count: String(off) }),
  ]
    .filter(Boolean)
    .join(" · ");
}

function ExperimentBlockRow({
  row,
  expanded,
  onToggle,
  children,
}: {
  row: ExperimentRowModel;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div data-testid="experiment-v8-row">
      <div className="group relative flex items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/50">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            EXPERIMENT_STATUS_DOT[row.status],
          )}
        />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="truncate text-left text-sm font-medium text-foreground after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
          >
            {row.name}
          </button>
          <NamedRuleEntryBadge kind="experiments" state={row.entryState} />
        </div>
        <span className="hidden w-36 shrink-0 items-center gap-2 text-xs text-muted-foreground sm:flex">
          <SplitDonut arms={shareArms(row.share)} size={18} thickness={3} />
          {t("sectionsEditor.namedRulePicker.shareOfVisitors", {
            share: String(row.share),
          })}
        </span>
        <span className="w-24 shrink-0 text-xs text-muted-foreground">
          {experimentStatusLabel(t, row.status)}
        </span>
        <ChevronRight
          size={16}
          aria-hidden
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
      </div>
      {children}
    </div>
  );
}

const EXPERIMENTS_BLOCK = namedRuleKindInfo("experiments").blockKey;

/** One side of the split, as the visitor sees it, with its share of traffic. */
function VersionCard({
  color,
  label,
  title,
  share,
}: {
  color: string;
  label: string;
  title: string;
  share: number;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-medium">{title}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold tabular-nums">{share}%</p>
        <p className="text-xs text-muted-foreground">
          {t("experiments.v8.versions.ofTraffic")}
        </p>
      </div>
    </div>
  );
}

function ExperimentBlockDetail(
  props: NamedRuleDetailProps<ExperimentRowModel>,
) {
  const { row, decofile, pending, holdsCopy, onSave } = props;
  const t = useT();
  // The share being edited, and the tests as they were when it was first
  // moved (the copy it is built on); `null` shows the share as stored. A
  // save hands the slider back to what is stored, which after a reconcile
  // ("take theirs") is their share, not the one typed here.
  const [editing, setEditing] = useState<{
    share: number;
    basis: unknown;
  } | null>(null);
  const setShare = (value: number) =>
    setEditing((now) => ({
      share: value,
      basis: now ? now.basis : decofile[EXPERIMENTS_BLOCK],
    }));
  const share = editing?.share ?? row.share;
  const shareDirty = share !== row.share;
  const [inColor, restColor] = armColors(shareArms(share)) as [string, string];

  const save = () => {
    const change = planNamedRuleSet(decofile, "experiments", row.name, share);
    // Hosted v8: guarded by the tests as the share was moved on.
    const basis = editing ? editing.basis : decofile[EXPERIMENTS_BLOCK];
    void onSave(
      change && holdsCopy
        ? { ...change, basis: { [EXPERIMENTS_BLOCK]: basis } }
        : change,
    ).then((ok) => ok && setEditing(null));
  };

  return (
    <div
      className="grid gap-6 border-t border-border bg-muted/30 px-5 py-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
      data-testid="experiment-v8-detail"
    >
      <section className="flex flex-col gap-3">
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
          compact
        />
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
        {shareDirty && (
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={pending} onClick={save}>
              {t("experiments.v8.save")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setEditing(null)}
            >
              {t("experiments.v8.split.reset", { share: String(row.share) })}
            </Button>
          </div>
        )}
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">
          {t("experiments.v8.versions.title")}
        </h3>
        <VersionCard
          color={inColor}
          label={t("experiments.v8.versions.test")}
          title={row.name}
          share={share}
        />
        <VersionCard
          color={restColor}
          label={t("experiments.v8.versions.control")}
          title={t("experiments.v8.versions.published")}
          share={100 - share}
        />
        <div className="mt-auto flex justify-end pt-1">
          <NamedRuleDetailDelete kind="experiments" detail={props} />
        </div>
      </section>
    </div>
  );
}

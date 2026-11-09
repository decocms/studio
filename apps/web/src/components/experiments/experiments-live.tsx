/**
 * A Blocks (v8) site's A/B tests as they are live: the published release's
 * `experiments` block, read-only. Monitor's Experiments view shows it in full
 * (a list, and one test's split by `?test=`), and the Experiments app shows
 * it compact under the tests being edited, so what is live sits next to the
 * draft. Nothing here writes: tests are created, changed and deleted in the
 * Experiments app, which every row and the header link to.
 */

import { Link, type LinkProps, useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, Beaker02 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { Page } from "@/components/page";
import { namedRuleViewBlocked } from "@/components/sections-editor/named-rule-view";
import { usePublishedContent } from "@/components/sections-editor/use-published-content";
import {
  SITE_DRAFT_VIEW_INSET,
  SiteDraftViewHeader,
} from "@/components/site-draft-bar/view-header";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import {
  type ExperimentRowModel,
  draftHasUnpublishedTests,
  liveExperimentRows,
} from "@/layouts/main-panel-tabs/experiments-v8-model";
import {
  SiteDraftGuide,
  SiteDraftView,
  type SiteDraftViewReady,
} from "@/layouts/main-panel-tabs/site-draft-view";
import { ExperimentStatusPill } from "./experiment-status-pill";
import { ShareSplit, SplitDonut, shareArms } from "./split-donut";
import { useOpenTestSearch } from "./use-open-test-search";

/** The layout keys a link keeps, so the app opens on the same draft. */
type LayoutSearch = { thread?: string; sidepanel?: boolean };

/** The Experiments app, on `test` when given. */
function experimentsAppLink(
  orgSlug: string,
  virtualMcpId: string,
  test?: string,
): LinkProps {
  return {
    to: PROJECT_ROUTE.experiments,
    params: { org: orgSlug, agentId: virtualMcpId },
    search: (prev: LayoutSearch) => ({
      thread: prev.thread,
      sidepanel: prev.sidepanel,
      test,
    }),
  } as LinkProps;
}

/** Monitor's Experiments view of the project. */
function experimentsMonitorLink(
  orgSlug: string,
  virtualMcpId: string,
): LinkProps {
  return {
    to: PROJECT_ROUTE.monitoring,
    params: { org: orgSlug, agentId: virtualMcpId },
    search: (prev: LayoutSearch) => ({
      thread: prev.thread,
      sidepanel: prev.sidepanel,
      view: "experiments",
    }),
  } as LinkProps;
}

export interface ExperimentsLiveProps {
  orgSlug: string;
  virtualMcpId: string;
  /** The published content; `null` while it loads. */
  published: Record<string, unknown> | null;
  /** The draft, only to say when it has changes not published yet. */
  draft: Record<string, unknown> | null;
  mode: "full" | "compact";
  /** Full: the test shown on its own (`?test=`). */
  openName?: string | null;
  /** Full: shows a test, or the list with `null`. Compact: opens a test in
   *  the editor above. */
  onOpen: (name: string | null) => void;
}

export function ExperimentsLive(props: ExperimentsLiveProps) {
  const { published, mode, openName } = props;
  if (!published) {
    return mode === "full" ? (
      <LiveSkeleton />
    ) : (
      <Skeleton
        className="h-16 w-full"
        data-testid="experiments-live-loading"
      />
    );
  }
  const rows = liveExperimentRows(published);
  const unpublished = props.draft
    ? draftHasUnpublishedTests(props.draft, published)
    : false;
  if (mode === "compact") {
    return <LiveCompact {...props} rows={rows} unpublished={unpublished} />;
  }
  const opened = rows.find((row) => row.name === openName) ?? null;
  if (opened) {
    return <LiveDetail {...props} row={opened} unpublished={unpublished} />;
  }
  return <LiveList {...props} rows={rows} unpublished={unpublished} />;
}

function LiveSkeleton() {
  return (
    <Page>
      <Page.Content>
        <div
          className={cn("flex flex-col gap-3", SITE_DRAFT_VIEW_INSET)}
          data-testid="experiments-live-loading"
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

/** "Edit in Experiments ↗", as a button in a header. */
function EditButton({
  orgSlug,
  virtualMcpId,
  test,
}: {
  orgSlug: string;
  virtualMcpId: string;
  test?: string;
}) {
  const t = useT();
  return (
    <Button asChild size="sm" variant="outline">
      <Link
        {...experimentsAppLink(orgSlug, virtualMcpId, test)}
        data-testid="experiments-live-edit"
      >
        {t("experiments.live.edit")}
        <ArrowUpRight size={14} />
      </Link>
    </Button>
  );
}

const QUIET_LINK =
  "inline-flex w-fit items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline";

/** The draft has test changes Publish would take live. */
function UnpublishedNote({
  orgSlug,
  virtualMcpId,
  withLink,
}: {
  orgSlug: string;
  virtualMcpId: string;
  withLink: boolean;
}) {
  const t = useT();
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground"
      data-testid="experiments-live-unpublished"
    >
      {t("experiments.live.unpublished")}
      {withLink && (
        <Link
          {...experimentsAppLink(orgSlug, virtualMcpId)}
          className={QUIET_LINK}
        >
          {t("experiments.live.edit")}
          <ArrowUpRight size={12} />
        </Link>
      )}
    </p>
  );
}

function ShareText({ share }: { share: number }) {
  const t = useT();
  return (
    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
      {t("sectionsEditor.namedRulePicker.shareOfVisitors", {
        share: String(share),
      })}
    </span>
  );
}

/** One live test: its name, share, a small donut and its status. */
function LiveRow({
  row,
  onOpen,
  edit,
}: {
  row: ExperimentRowModel;
  onOpen: () => void;
  /** Full: the row's "Edit ↗" link into the app. */
  edit?: LinkProps;
}) {
  const t = useT();
  return (
    <div
      className="group relative flex items-center gap-4 px-5 py-3 transition-colors hover:bg-muted/50"
      data-testid="experiment-live-row"
    >
      <div aria-hidden="true" className="shrink-0">
        <SplitDonut arms={shareArms(row.share)} size={28} thickness={5} />
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
      >
        {row.name}
      </button>
      <ShareText share={row.share} />
      <div className="flex w-24 shrink-0">
        <ExperimentStatusPill status={row.status} />
      </div>
      {edit && (
        <Link
          {...edit}
          className={cn(QUIET_LINK, "relative z-10 shrink-0 text-xs")}
          data-testid="experiment-live-row-edit"
        >
          {t("experiments.live.editTest")}
          <ArrowUpRight size={12} />
        </Link>
      )}
    </div>
  );
}

function LiveRows({
  rows,
  onOpen,
  edit,
}: {
  rows: ExperimentRowModel[];
  onOpen: (name: string) => void;
  edit?: (name: string) => LinkProps;
}) {
  return (
    <Card
      size="flush"
      className="gap-0 divide-y divide-border overflow-hidden"
      data-testid="experiments-live-list"
    >
      {rows.map((row) => (
        <LiveRow
          key={row.name}
          row={row}
          onOpen={() => onOpen(row.name)}
          edit={edit?.(row.name)}
        />
      ))}
    </Card>
  );
}

function LiveList({
  orgSlug,
  virtualMcpId,
  onOpen,
  rows,
  unpublished,
}: ExperimentsLiveProps & {
  rows: ExperimentRowModel[];
  unpublished: boolean;
}) {
  const t = useT();
  return (
    <Page>
      <SiteDraftViewHeader
        intro={t("experiments.live.intro")}
        actions={<EditButton orgSlug={orgSlug} virtualMcpId={virtualMcpId} />}
      />
      <Page.Content>
        <div
          className={cn("flex flex-col gap-4", SITE_DRAFT_VIEW_INSET)}
          data-testid="experiments-live"
        >
          {unpublished && (
            <UnpublishedNote
              orgSlug={orgSlug}
              virtualMcpId={virtualMcpId}
              withLink
            />
          )}
          {rows.length === 0 ? (
            <EmptyState
              icon={<Beaker02 size={28} className="text-muted-foreground" />}
              title={t("experiments.live.empty.title")}
              description={t("experiments.live.empty.desc")}
            />
          ) : (
            <LiveRows
              rows={rows}
              onOpen={onOpen}
              edit={(name) => experimentsAppLink(orgSlug, virtualMcpId, name)}
            />
          )}
        </div>
      </Page.Content>
    </Page>
  );
}

function LiveDetail({
  orgSlug,
  virtualMcpId,
  onOpen,
  row,
  unpublished,
}: ExperimentsLiveProps & {
  row: ExperimentRowModel;
  unpublished: boolean;
}) {
  const t = useT();
  const back = () => onOpen(null);
  return (
    <Page>
      <Page.Breadcrumbs
        after="page"
        parent={{ label: t("experiments.title"), onSelect: back }}
        items={[{ key: "experiment", label: row.name }]}
      />
      <SiteDraftViewHeader
        back={{ label: t("experiments.v8.allTests"), onClick: back }}
        actions={
          <EditButton
            orgSlug={orgSlug}
            virtualMcpId={virtualMcpId}
            test={row.name}
          />
        }
      />
      <Page.Content>
        <div
          className={cn("flex max-w-2xl flex-col gap-6", SITE_DRAFT_VIEW_INSET)}
          data-testid="experiment-live-detail"
        >
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-lg font-medium">{row.name}</h2>
            <ExperimentStatusPill status={row.status} />
          </div>
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">
              {t("experiments.v8.shareTitle")}
            </h3>
            <ShareSplit
              value={row.share}
              readOnly
              sliderLabel={t("experiments.v8.shareLabel")}
              inTestLabel={t("experiments.v8.split.inTest")}
              restLabel={t("experiments.v8.split.rest")}
              centerLabel={t("experiments.v8.split.center")}
            />
          </section>
          {unpublished && (
            <UnpublishedNote
              orgSlug={orgSlug}
              virtualMcpId={virtualMcpId}
              withLink={false}
            />
          )}
        </div>
      </Page.Content>
    </Page>
  );
}

function LiveCompact({
  orgSlug,
  virtualMcpId,
  onOpen,
  rows,
  unpublished,
}: ExperimentsLiveProps & {
  rows: ExperimentRowModel[];
  unpublished: boolean;
}) {
  const t = useT();
  return (
    <section
      className="flex flex-col gap-2 pt-2"
      data-testid="experiments-live-compact"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-sm font-medium">{t("experiments.live.title")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("experiments.live.intro")}
          </p>
        </div>
        <Link
          {...experimentsMonitorLink(orgSlug, virtualMcpId)}
          className={cn(QUIET_LINK, "text-xs")}
          data-testid="experiments-live-monitor"
        >
          {t("experiments.live.viewInMonitor")}
          <ArrowUpRight size={12} />
        </Link>
      </div>
      {unpublished && (
        <UnpublishedNote
          orgSlug={orgSlug}
          virtualMcpId={virtualMcpId}
          withLink={false}
        />
      )}
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("experiments.live.empty.title")}
        </p>
      ) : (
        <LiveRows rows={rows} onOpen={onOpen} />
      )}
    </section>
  );
}

function LiveGuide(props: {
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <SiteDraftGuide
      icon={<Beaker02 size={28} className="text-muted-foreground" />}
      {...props}
    />
  );
}

/**
 * Monitor's Experiments view of a Blocks v8 project: its live tests, read
 * from the published side of the session's draft (the only way the web app
 * reads a published release). It never writes and has no draft bar.
 */
export function ProjectExperimentsLive({
  virtualMcpId,
}: {
  virtualMcpId: string;
}) {
  const t = useT();
  const task = useOptionalChatTask();
  if (!task?.currentBranch) {
    return <NoDraftGuide virtualMcpId={virtualMcpId} />;
  }
  return (
    <SiteDraftView
      virtualMcpId={virtualMcpId}
      icon={<Beaker02 size={28} className="text-muted-foreground" />}
      copy={{
        noDraftTitle: t("experiments.title"),
        noDraftDesc: t("experiments.live.noDraft"),
        loadFailed: t("experiments.v8.loadFailed"),
        loadFailedHint: t("sectionsEditor.namedRules.unavailableHint"),
      }}
      skeleton={<LiveSkeleton />}
    >
      {(ready) => <ProjectExperimentsLiveReady {...ready} />}
    </SiteDraftView>
  );
}

/** No draft to read the published side from: the way to the app. */
function NoDraftGuide({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const navigate = useNavigate();
  return (
    <LiveGuide
      title={t("experiments.title")}
      description={t("experiments.live.noDraft")}
      action={{
        label: t("experiments.live.edit"),
        onClick: () =>
          void navigate({
            to: PROJECT_ROUTE.experiments,
            params: { org: org.slug, agentId: virtualMcpId },
            search: (prev: LayoutSearch) => ({
              thread: prev.thread,
              sidepanel: prev.sidepanel,
            }),
          }),
      }}
    />
  );
}

function ProjectExperimentsLiveReady({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  meta,
}: SiteDraftViewReady) {
  const t = useT();
  const open = useOpenTestSearch();
  const published = usePublishedContent({
    orgSlug,
    virtualMcpId,
    branch,
    decofile,
  });
  const blocked = namedRuleViewBlocked(decofile, meta, "experiments");
  if (blocked) {
    return (
      <LiveGuide
        title={t(`experiments.v8.${blocked}.title`)}
        description={t(`experiments.v8.${blocked}.desc`)}
      />
    );
  }
  return (
    <ExperimentsLive
      orgSlug={orgSlug}
      virtualMcpId={virtualMcpId}
      published={published}
      draft={decofile}
      mode="full"
      openName={open.name}
      onOpen={open.set}
    />
  );
}

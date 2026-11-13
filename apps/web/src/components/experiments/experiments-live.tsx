/**
 * A Blocks (v8) site's A/B tests as they are live: the published release's
 * `experiments` block, read-only. Monitor's Experiments view shows it in full
 * (a list, and one test's split by `?test=`), and the Experiments app shows
 * it compact under the tests being edited, so what is live sits next to the
 * draft. Nothing here writes: tests are created, changed and deleted in the
 * Experiments app, which every row and the header link to.
 *
 * "Live" is never the draft's copy: when the draft changed the tests and
 * their published side can't be read, the view says so instead of showing
 * the draft as live (`usePublishedRead`).
 */

import { Link, type LinkProps } from "@tanstack/react-router";
import { ArrowUpRight, Beaker02, ChevronRight } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { Page } from "@/components/page";
import type { NamedRuleEntryState } from "@/components/sections-editor/named-rule-edits";
import {
  NamedRuleEntryBadge,
  namedRuleViewBlocked,
} from "@/components/sections-editor/named-rule-view";
import {
  type PublishedRead,
  usePublishedRead,
} from "@/components/sections-editor/use-published-content";
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
  experimentRows,
  liveExperimentRows,
} from "@/layouts/main-panel-tabs/experiments-v8-model";
import {
  SiteDraftGuide,
  type SiteDraftGuideAction,
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
  /** The `experiments` block as it is live. */
  published: PublishedRead;
  /** The draft: what it changes, and which tests the editor can open. */
  draft: Record<string, unknown> | null;
  mode: "full" | "compact";
  /** Full: the test shown on its own (`?test=`). */
  openName?: string | null;
  /** Full: shows a test, or the list with `null`. Compact: opens a test of
   *  the draft in the editor above. */
  onOpen: (name: string | null) => void;
}

/** A live test against the draft: `removed` when the draft deleted it;
 *  `null` when there is no draft to compare with. */
type DraftSide = NamedRuleEntryState | "removed" | null;

interface LiveRowModel extends ExperimentRowModel {
  draft: DraftSide;
}

function liveRows(
  published: Record<string, unknown>,
  draft: Record<string, unknown> | null,
): LiveRowModel[] {
  const inDraft = draft
    ? new Map(experimentRows(draft, published).map((row) => [row.name, row]))
    : null;
  return liveExperimentRows(published).map((row) => ({
    ...row,
    draft: inDraft ? (inDraft.get(row.name)?.entryState ?? "removed") : null,
  }));
}

/** Whether the editor can open `name`: the draft has it (or isn't known). */
function draftHas(
  draft: Record<string, unknown> | null,
  name: string,
): boolean {
  return !draft || experimentRows(draft, null).some((row) => row.name === name);
}

export function ExperimentsLive(props: ExperimentsLiveProps) {
  const { published, mode, openName } = props;
  if (published.state !== "ready") {
    return <LiveNotReady {...props} read={published} />;
  }
  const rows = liveRows(published.content, props.draft);
  if (mode === "compact") return <LiveCompact {...props} rows={rows} />;
  const unpublished = props.draft
    ? draftHasUnpublishedTests(props.draft, published.content)
    : false;
  const opened = rows.find((row) => row.name === openName) ?? null;
  if (opened) return <LiveDetail {...props} row={opened} />;
  return (
    <LiveList
      {...props}
      rows={rows}
      unpublished={unpublished}
      notLive={openName ?? null}
    />
  );
}

/** Loading, failed, or not knowable: never the draft shown as live. */
function LiveNotReady({
  mode,
  read,
}: ExperimentsLiveProps & {
  read: Exclude<PublishedRead, { state: "ready" }>;
}) {
  const t = useT();
  if (read.state === "loading") {
    return mode === "full" ? (
      <LiveSkeleton />
    ) : (
      <Skeleton
        className="h-16 w-full"
        data-testid="experiments-live-loading"
      />
    );
  }
  const title =
    read.state === "failed"
      ? t("experiments.v8.loadFailed")
      : t("experiments.live.unknown.title");
  const description =
    read.state === "failed"
      ? t("sectionsEditor.namedRules.unavailableHint")
      : t("experiments.live.unknown.desc");
  const retry = read.state === "failed" ? read.retry : null;
  if (mode === "full") {
    return (
      <LiveGuide
        title={title}
        description={description}
        action={
          retry
            ? { label: t("sectionsEditor.namedRules.tryAgain"), onClick: retry }
            : undefined
        }
      />
    );
  }
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-2 text-xs text-muted-foreground"
      data-testid="experiments-live-unavailable"
      role="status"
    >
      <span className="font-medium text-foreground">{title}</span>
      <span>{description}</span>
      {retry && (
        <Button size="sm" variant="ghost" onClick={retry}>
          {t("sectionsEditor.namedRules.tryAgain")}
        </Button>
      )}
    </div>
  );
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

/** A quiet line under a header, with the way to the app when given. */
function LiveNote({
  text,
  link,
  testId,
}: {
  text: string;
  link?: LinkProps;
  testId: string;
}) {
  const t = useT();
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground"
      data-testid={testId}
    >
      {text}
      {link && (
        <Link {...link} className={QUIET_LINK}>
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
    <span className="w-32 shrink-0 text-xs tabular-nums text-muted-foreground">
      {t("sectionsEditor.namedRulePicker.shareOfVisitors", {
        share: String(share),
      })}
    </span>
  );
}

/** What the draft does to a live test, in the editor list's badge column. */
function DraftBadge({ draft }: { draft: DraftSide }) {
  const t = useT();
  if (draft === "removed") {
    return <Badge variant="muted">{t("experiments.v8.removedTitle")}</Badge>;
  }
  return <NamedRuleEntryBadge kind="experiments" state={draft} />;
}

/**
 * One live test: its name, share, how the draft changes it and its status,
 * in the editor list's columns. Full (Monitor): a small donut first and an
 * "Edit ↗" link into the app; the name opens the test here. Compact (the
 * app): the name opens the test in the editor above, when the draft has it.
 */
function LiveRow({
  row,
  onOpen,
  edit,
}: {
  row: LiveRowModel;
  /** `null`: nothing to open (the draft removed the test). */
  onOpen: (() => void) | null;
  /** Full: the row's "Edit ↗" link into the app. */
  edit?: LinkProps;
}) {
  const t = useT();
  const full = edit !== undefined;
  const nameClass =
    "min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground";
  return (
    <div
      className="group relative flex items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/50"
      data-testid="experiment-live-row"
    >
      {full && (
        <div aria-hidden="true" className="shrink-0">
          <SplitDonut arms={shareArms(row.share)} size={28} thickness={5} />
        </div>
      )}
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          // Compact: the row leaves what is live for the editor; say so.
          aria-label={
            full ? undefined : t("experiments.live.editRow", { name: row.name })
          }
          className={cn(
            nameClass,
            "after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset",
          )}
        >
          {row.name}
        </button>
      ) : (
        <span className={nameClass}>{row.name}</span>
      )}
      <ShareText share={row.share} />
      <div className="hidden w-40 shrink-0 md:flex">
        <DraftBadge draft={row.draft} />
      </div>
      <div className="flex w-24 shrink-0">
        <ExperimentStatusPill status={row.status} />
      </div>
      {edit && (
        <Link
          {...edit}
          aria-label={t("experiments.live.editNamed", { name: row.name })}
          className={cn(QUIET_LINK, "relative z-10 shrink-0 text-xs")}
          data-testid="experiment-live-row-edit"
        >
          {t("experiments.live.editTest")}
          <ArrowUpRight size={12} />
        </Link>
      )}
      {!full && (
        <ChevronRight
          size={16}
          aria-hidden="true"
          className={cn(
            "shrink-0 text-muted-foreground",
            !onOpen && "invisible",
          )}
        />
      )}
    </div>
  );
}

function LiveRows({
  rows,
  onOpen,
  edit,
}: {
  rows: LiveRowModel[];
  /** `null` for a row with nothing to open. */
  onOpen: (row: LiveRowModel) => (() => void) | null;
  edit?: (row: LiveRowModel) => LinkProps;
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
          onOpen={onOpen(row)}
          edit={edit?.(row)}
        />
      ))}
    </Card>
  );
}

/** The app opens a test the draft has; one it removed opens the list. */
function editTarget(row: LiveRowModel): string | undefined {
  return row.draft === "removed" ? undefined : row.name;
}

function LiveList({
  orgSlug,
  virtualMcpId,
  draft,
  onOpen,
  rows,
  unpublished,
  notLive,
}: ExperimentsLiveProps & {
  rows: LiveRowModel[];
  unpublished: boolean;
  /** A `?test=` no live test has. */
  notLive: string | null;
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
          {notLive !== null && (
            <LiveNote
              testId="experiments-live-not-live"
              text={t("experiments.live.notLive", { name: notLive })}
              link={experimentsAppLink(
                orgSlug,
                virtualMcpId,
                draftHas(draft, notLive) ? notLive : undefined,
              )}
            />
          )}
          {unpublished && (
            <LiveNote
              testId="experiments-live-unpublished"
              text={t("experiments.live.unpublished")}
              link={experimentsAppLink(orgSlug, virtualMcpId)}
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
              onOpen={(row) => () => onOpen(row.name)}
              edit={(row) =>
                experimentsAppLink(orgSlug, virtualMcpId, editTarget(row))
              }
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
}: ExperimentsLiveProps & { row: LiveRowModel }) {
  const t = useT();
  const back = () => onOpen(null);
  // Only what the draft does to this test, not to the others.
  const note =
    row.draft === "removed"
      ? t("experiments.live.removedTest")
      : row.draft === "changed" || row.draft === "new"
        ? t("experiments.live.unpublishedTest")
        : null;
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
            test={editTarget(row)}
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
              inTestLabel={t("experiments.v8.split.inTest")}
              restLabel={t("experiments.v8.split.rest")}
              centerLabel={t("experiments.v8.split.center")}
            />
          </section>
          {note && (
            <LiveNote testId="experiments-live-unpublished" text={note} />
          )}
        </div>
      </Page.Content>
    </Page>
  );
}

function LiveCompact({
  orgSlug,
  virtualMcpId,
  draft,
  onOpen,
  rows,
}: ExperimentsLiveProps & { rows: LiveRowModel[] }) {
  const t = useT();
  // The draft list above already badges each test it changes, so no note
  // repeats it here.
  return (
    <section
      className="flex flex-col gap-2 pt-2"
      aria-labelledby="experiments-live-title"
      data-testid="experiments-live-compact"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="experiments-live-title" className="text-sm font-medium">
            {t("experiments.live.title")}
          </h2>
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
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("experiments.live.empty.title")}
        </p>
      ) : (
        <LiveRows
          rows={rows}
          onOpen={(row) =>
            draftHas(draft, row.name) ? () => onOpen(row.name) : null
          }
        />
      )}
    </section>
  );
}

function LiveGuide(props: {
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

/**
 * Monitor's Experiments view of a Blocks v8 project: its live tests, read
 * from the published side of the session's draft. That is the only way the
 * web app reads a published release (there is no read of the live release
 * without a draft), and on Studio's hosted backend that side is the live
 * release itself. It never writes and has no draft bar.
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
        noDraftTitle: t("experiments.live.noDraft.title"),
        noDraftDesc: t("experiments.live.noDraft.desc"),
        loadFailed: t("experiments.v8.loadFailed"),
        loadFailedHint: t("sectionsEditor.namedRules.unavailableHint"),
      }}
      skeleton={<LiveSkeleton />}
    >
      {(ready) => <ProjectExperimentsLiveReady {...ready} />}
    </SiteDraftView>
  );
}

/**
 * No draft to read the published side from: why, and the way to pick one
 * (the app has the draft bar).
 */
function NoDraftGuide({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const { org } = useProjectContext();
  return (
    <Page>
      <Page.Content>
        <Page.Container>
          <EmptyState
            icon={<Beaker02 size={28} className="text-muted-foreground" />}
            title={t("experiments.live.noDraft.title")}
            description={t("experiments.live.noDraft.desc")}
            buttonComponent={
              <Button asChild size="sm">
                <Link
                  {...experimentsAppLink(org.slug, virtualMcpId)}
                  data-testid="experiments-live-pick-draft"
                >
                  {t("experiments.live.noDraft.action")}
                </Link>
              </Button>
            }
          />
        </Page.Container>
      </Page.Content>
    </Page>
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
  const published = usePublishedRead({
    orgSlug,
    virtualMcpId,
    branch,
    decofile,
    blockKey: "experiments",
  });
  // The schema says whether the site has tests at all; a clashing block is
  // the published content's, not the draft's (the editor guides that one).
  const blocked = namedRuleViewBlocked(
    published.state === "ready" ? published.content : {},
    meta,
    "experiments",
  );
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

/**
 * The Monitor destination, org or project: is today a normal day, and if
 * not, why and what to do. Top to bottom: the pulse (KPIs against
 * yesterday), today's orders with every deploy marked on them beside what
 * needs attention, the deploys and their effect, the projects side by side
 * (org only), experiments, and the sources feeding it all. A store opens its
 * full day (the order monitor's own view) in place.
 */

import { type ReactNode, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Activity, GitBranch01, Plus } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import {
  DayInput,
  localInstant,
} from "@/components/order-monitor/order-monitor-day";
import { Page } from "@/components/page";
import {
  DESTINATION_ROUTE,
  PROJECT_ROUTE,
} from "@/hooks/use-destination-route";
import { useT } from "@/i18n/use-t.ts";
import {
  type Kpi,
  type KpiId,
  type MonitorBoard,
  scopeBoard,
  type SourceId,
  sortSignals,
  storeTimezone,
} from "./board";
import { ChannelsChart } from "./channels-chart";
import { ChangeFocusProvider, MetricChart } from "./metric-chart";
import {
  AudienceView,
  DeploysView,
  ExperimentsView,
  MonitorTabs,
  type MonitorView,
  PerformanceView,
  useSiteProjects,
} from "./monitor-views";
import { AudienceGlance } from "./audience-view";
import { connectLink, localDay } from "./parts";
import { Locked } from "./locked";
import { MonitoredRepos } from "./monitored-repos";
import { ProjectsTable } from "./projects-table";
import { SignalsPanel } from "./signals-panel";
import { monitorPreview } from "./preview";
import { StoreDay } from "./store-day";
import { StoresTable } from "./stores-table";
import { sourceName } from "./sources-panel";
import { useSourceIcons } from "./use-source-icons";

export interface MonitorSelection {
  view?: MonitorView;
  /** A past local day, `YYYY-MM-DD`; today when absent. */
  date?: string;
  store?: string;
  at?: string;
}

/** What the board's controls change: which day, and whether deploys are drawn. */
interface BoardControls {
  date: string;
  onDate: (date: string) => void;
  showChanges: boolean;
  onShowChanges: (show: boolean) => void;
  hasChanges: boolean;
}

/**
 * Every page control in the panel's top bar, where the board analytics keep
 * theirs: the day and the deploys toggle (on the board only), then the way
 * to connect a source. Each chart picks its own reference days.
 */
function Actions({
  orgSlug,
  scopeId,
  controls,
  repos,
}: {
  orgSlug: string;
  scopeId: string | null;
  controls: BoardControls | null;
  /** Which repositories the Deploys tab follows, once it follows any. */
  repos: boolean;
}) {
  const t = useT();
  return (
    <Page.Actions>
      {repos && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1">
              <GitBranch01 size={14} />
              {t("monitor.repos.button")}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-3">
            <MonitoredRepos />
          </PopoverContent>
        </Popover>
      )}
      {controls && (
        <>
          <DayInput
            value={controls.date}
            max={localDay(new Date())}
            onChange={controls.onDate}
          />
          {controls.hasChanges && (
            <label className="text-meta flex cursor-pointer items-center gap-2 px-1">
              <Switch
                checked={controls.showChanges}
                onCheckedChange={controls.onShowChanges}
              />
              {t("monitor.chart.changes")}
            </label>
          )}
        </>
      )}
      <Button asChild variant="outline" size="sm" className="gap-1">
        <Link {...connectLink(orgSlug, scopeId)}>
          <Plus size={14} />
          {t("monitor.connectSource")}
        </Link>
      </Button>
    </Page.Actions>
  );
}

const CARD_ORDER: readonly KpiId[] = [
  "orders",
  "cancellations",
  "conversion",
  "audience",
  "errors",
  "latency",
];

/** Where each card's numbers come from once the org is live. */
const LIVE_SOURCE: Record<KpiId, SourceId> = {
  orders: "orders",
  cancellations: "orders",
  conversion: "analytics",
  audience: "site",
  latency: "site",
  errors: "site",
};

function Board({
  board,
  orgSlug,
  scopeId,
  selection,
  onSelect,
  showChanges,
  preview,
  bare = false,
  audience,
}: {
  board: MonitorBoard;
  orgSlug: string;
  scopeId: string | null;
  selection: MonitorSelection;
  onSelect: (selection: MonitorSelection) => void;
  showChanges: boolean;
  /** Every card the page can show, with preview numbers, for the ones not fed yet. */
  preview: readonly Kpi[] | null;
  /** Drawn under the page's connect card: no buttons of its own. */
  bare?: boolean;
  /** Today's audience at a glance, when the scope is one site. */
  audience?: ReactNode;
}) {
  const t = useT();
  const signals = sortSignals(board.signals);
  const connect = connectLink(orgSlug, scopeId);
  const iconOf = useSourceIcons(orgSlug, board.sources);
  const changes = board.deploys ?? [];
  // Under the connect card the whole page is laid out with preview numbers;
  // once a source is in, only the cards something feeds are drawn.
  const kpis: Kpi[] =
    preview && bare
      ? preview.map(
          (sample) =>
            board.kpis.find((k) => k.id === sample.id) ?? {
              ...sample,
              source: LIVE_SOURCE[sample.id],
              value: null,
              points: null,
            },
        )
      : board.kpis;
  // Orders, then what happens to them, then the site behind them.
  const [orders, ...rest] = [...kpis].sort(
    (a, b) => CARD_ORDER.indexOf(a.id) - CARD_ORDER.indexOf(b.id),
  );
  const chart = (kpi: Kpi, className?: string) => (
    <MetricChart
      key={kpi.id}
      kpi={kpi}
      preview={preview?.find((p) => p.id === kpi.id)}
      waiting={board.sources.find((s) => s.id === kpi.source)?.state === "live"}
      comingSoon={!board.kpis.some((k) => k.id === kpi.id)}
      changes={changes}
      showChanges={showChanges}
      dayStart={board.dayStart}
      sourceName={sourceName(kpi.source, t)}
      icon={iconOf(kpi.source)}
      connect={connect}
      bare={bare}
      className={className}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      {!bare && audience}
      {signals.length > 0 && (
        <SignalsPanel
          signals={signals}
          orgSlug={orgSlug}
          scopeId={scopeId}
          onOpenStore={(store) => onSelect({ ...selection, store })}
          iconOf={iconOf}
        />
      )}
      <ChangeFocusProvider>
        {orders && chart(orders)}
        <div className="grid gap-4 md:grid-cols-2">
          {/* Cancellations beside the channels: both are about the orders. */}
          {rest.slice(0, 1).map((kpi) => chart(kpi))}
          {board.channels && board.channels.length > 1 && (
            <ChannelsChart channels={board.channels} />
          )}
          {rest.slice(1).map((kpi) => chart(kpi))}
        </div>
      </ChangeFocusProvider>
      {!bare && board.stores.length > 0 && (
        <div className="mt-6">
          <StoresTable
            stores={board.stores}
            orgSlug={orgSlug}
            onOpen={(store) => onSelect({ ...selection, store })}
          />
        </div>
      )}
      {!scopeId && board.projects.length > 1 && (
        <div className="mt-6">
          <ProjectsTable projects={board.projects} orgSlug={orgSlug} />
        </div>
      )}
    </div>
  );
}

export function MonitorPage({
  board: orgBoard,
  loading,
  error,
  orgSlug,
  scopeId,
  selection,
  onSelect,
}: {
  board: MonitorBoard;
  loading: boolean;
  error: Error | null;
  orgSlug: string;
  scopeId: string | null;
  selection: MonitorSelection;
  onSelect: (selection: MonitorSelection) => void;
}) {
  const t = useT();
  const board = scopeBoard(orgBoard, scopeId);
  /** A past day's last second in the store's own timezone. */
  const storeDayEnd = (connectionId: string, date: string | undefined) => {
    const store = board.stores.find(
      (s) => s.store.connectionId === connectionId,
    );
    return date && store
      ? localInstant(date, "23:59:59", storeTimezone(store.store))
      : undefined;
  };
  const stateOf = (id: SourceId) =>
    board.sources.find((s) => s.id === id)?.state ?? "off";
  const view = selection.view ?? "metrics";
  const scopeProject = useSiteProjects().find((p) => p.id === scopeId);
  // Everything the page can show is laid out from the start; what no source
  // feeds yet is drawn from the preview, faded, under its connect button.
  const shown = monitorPreview(scopeId, selection.date);
  const preview = shown.kpis;
  const [showChanges, setShowChanges] = useState(true);
  const tabs = (
    <MonitorTabs
      view={view}
      onView={(next) =>
        onSelect({ view: next === "metrics" ? undefined : next })
      }
    />
  );
  // Experiments, Performance and Audience are a project's own screens, with their frame.
  if (view === "experiments") {
    return (
      <>
        {tabs}
        <ExperimentsView scopeId={scopeId} />
      </>
    );
  }
  if (view === "audience") {
    return (
      <>
        {tabs}
        <AudienceView scopeId={scopeId} />
      </>
    );
  }
  if (view === "performance") {
    return (
      <>
        {tabs}
        <PerformanceView
          scopeId={scopeId}
          date={selection.date ?? localDay(new Date())}
          onDate={(date) =>
            onSelect({
              ...selection,
              date: date === localDay(new Date()) ? undefined : date,
            })
          }
        />
      </>
    );
  }
  // Nothing to draw, whatever is connected: a site alone has no numbers yet.
  const nothing =
    board.stores.length === 0 &&
    !board.deploys?.length &&
    !board.experiments?.length &&
    board.kpis.every((k) => k.value === null);

  // The connect card covers the page only while nothing at all is connected;
  // once one source is in, the page shows and each card still missing its
  // source carries its own button.
  const unconnected = board.sources.every((s) => s.state === "off");

  let body: ReactNode;
  if (view === "deploys") {
    body = board.deploys ? (
      <DeploysView
        deploys={board.deploys}
        history={board.deployHistory}
        orgSlug={orgSlug}
        scopeId={scopeId}
      />
    ) : (
      <Locked
        kind="deploys"
        title={t("monitor.locked.deploys.title")}
        {...(stateOf("deploys") === "partial"
          ? {
              guide: (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-muted-foreground">
                    {t("monitor.repos.hint")}
                  </p>
                  <MonitoredRepos />
                </div>
              ),
            }
          : { steps: [{ source: "deploys", state: stateOf("deploys") }] })}
        link={connectLink(orgSlug, scopeId)}
      >
        <DeploysView
          deploys={shown.deploys}
          history={shown.deployHistory}
          orgSlug={orgSlug}
          scopeId={scopeId}
        />
      </Locked>
    );
  } else if (selection.store) {
    body = (
      <StoreDay
        store={board.stores.find(
          (s) => s.store.connectionId === selection.store,
        )}
        storeId={selection.store}
        orgSlug={orgSlug}
        scopeId={scopeId}
        at={selection.at ?? storeDayEnd(selection.store, selection.date)}
        monitorLink={
          scopeId
            ? {
                to: PROJECT_ROUTE.monitoring,
                params: { org: orgSlug, agentId: scopeId },
              }
            : {
                to: DESTINATION_ROUTE.monitoring,
                params: { org: orgSlug },
              }
        }
        onBackToNow={() => onSelect({ store: selection.store })}
      />
    );
  } else if (loading) {
    body = (
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  } else if (error) {
    body = (
      <EmptyState
        icon={<Activity size={20} />}
        title={t("monitor.loadError")}
        description={error.message}
      />
    );
  } else if (unconnected) {
    body = (
      <Locked
        kind="metrics"
        title={t("monitor.locked.metrics.title")}
        steps={(["orders", "analytics", "site", "deploys"] as const).map(
          (source) => ({ source, state: stateOf(source) }),
        )}
        link={connectLink(orgSlug, scopeId)}
      >
        <Board
          board={board}
          selection={selection}
          orgSlug={orgSlug}
          scopeId={scopeId}
          onSelect={onSelect}
          showChanges={showChanges}
          preview={preview}
          bare
        />
      </Locked>
    );
  } else {
    body = (
      <Board
        board={board}
        selection={selection}
        orgSlug={orgSlug}
        scopeId={scopeId}
        onSelect={onSelect}
        showChanges={showChanges}
        preview={preview}
        audience={
          scopeProject && (
            <AudienceGlance
              project={scopeProject}
              onOpen={() => onSelect({ view: "audience" })}
            />
          )
        }
      />
    );
  }
  // A store's day keeps the day picker; the deploys toggle is the board's.
  const onBoard =
    view === "metrics" && !loading && !error && (!!selection.store || !nothing);
  const controls: BoardControls | null = onBoard
    ? {
        date: selection.date ?? localDay(new Date()),
        onDate: (date) =>
          onSelect({
            ...selection,
            date: date === localDay(new Date()) ? undefined : date,
            at: undefined,
          }),
        showChanges,
        onShowChanges: setShowChanges,
        hasChanges: !selection.store && (board.deploys?.length ?? 0) > 0,
      }
    : null;

  // The board analytics' frame: same width, gutters and rhythm.
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      {tabs}
      <Actions
        orgSlug={orgSlug}
        scopeId={scopeId}
        controls={controls}
        repos={view === "deploys" && board.deploys !== null}
      />
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 pt-6 pb-10 md:px-10">
        {body}
      </div>
    </div>
  );
}

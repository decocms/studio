/** The Monitor, org or project: ask about the data, what needs attention, the numbers that matter. */

import { useState, type ReactNode } from "react";
import { Activity, GitBranch01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Combobox } from "@decocms/ui/components/combobox.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
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
  type MonitorBoard,
  type SourceId,
  sortSignals,
  storeTimezone,
} from "./board";
import { AlertsView } from "./alerts-view";
import { AskData } from "./ask-data";
import {
  AudienceView,
  MonitorHeatmap,
  MonitorTabs,
  type MonitorView,
  PerformanceView,
  useSiteProjects,
} from "./monitor-views";
import { DeploysView } from "./deploys-view";
import { ExperimentsView } from "./experiments-view";
import { LogsView } from "./logs-view";
import { MonitoredRepos } from "./monitored-repos";
import { MonitorFrame } from "./monitor-frame";
import { monitorScope, ProjectFilter } from "./project-filter";
import { connectLink, localDay } from "./parts";
import { ConnectMore, Locked } from "./locked";
import { AllClear, SignalsPanel } from "./signals-panel";
import { StoreDay } from "./store-day";
import { NumberCards, OverviewNumbers } from "./overview-numbers";
import { MonitorOrgPicker } from "./monitor-org";
import { SalesStatus } from "./sales-status";
import { Sparkline } from "./sparkline";

export interface MonitorSelection {
  view?: MonitorView;
  /** Across the org, the one project every tab shows (the filter's pick). */
  project?: string;
  /** A past local day, `YYYY-MM-DD`; today when absent. */
  date?: string;
  store?: string;
  at?: string;
  /** From an admin org: another org's slug, or `all`. */
  customer?: string;
}

/** What the board's controls change: which day. */
interface BoardControls {
  date: string;
  onDate: (date: string) => void;
}

/** The day picker, in the panel's top bar where the board analytics keep theirs; an admin org's customer picker beside it. */
function Actions({
  controls,
  customer,
}: {
  controls: BoardControls | null;
  customer: ReactNode;
}) {
  if (!controls && !customer) return null;
  return (
    <Page.Actions>
      {customer}
      {controls && (
        <DayInput
          value={controls.date}
          max={localDay(new Date())}
          onChange={controls.onDate}
        />
      )}
    </Page.Actions>
  );
}

/** Made-up numbers for the faded Overview behind the connect card. */
const PREVIEW_NUMBERS = [
  { key: "orders", label: "monitor.overview.orders", value: "317" },
  { key: "visitors", label: "monitor.overview.visitors", value: "21,904" },
  { key: "pageviews", label: "monitor.overview.pageviews", value: "68,350" },
  {
    key: "cancellations",
    label: "monitor.overview.cancellations",
    value: "4",
  },
] as const;
const PREVIEW_SHAPE = [3, 2, 2, 4, 7, 9, 8, 10, 12, 11, 13, 12, 9, 10];

/**
 * Once every store's day is in, so the totals don't grow as they land. A
 * brand with several stores can narrow it to one; across all customers the
 * bars split by store instead.
 */
function OverviewSales({
  board,
  canPickStore,
}: {
  board: MonitorBoard;
  canPickStore: boolean;
}) {
  const t = useT();
  const [store, setStore] = useState<string | null>(null);
  const loaded = board.stores.flatMap((s) => (s.day ? [s] : []));
  if (loaded.length === 0 || loaded.length !== board.stores.length) return null;
  const shown = loaded.filter(
    (s) => store === null || s.store.connectionId === store,
  );
  const stores = shown.length > 0 ? shown : loaded;
  const picker = canPickStore && loaded.length > 1 && (
    <Combobox
      options={[
        { value: "", label: t("monitor.sales.allStores") },
        ...loaded.map((s) => ({
          value: s.store.connectionId,
          label: s.store.title,
        })),
      ]}
      value={store ?? ""}
      onChange={(next) => setStore(next || null)}
      width="w-[200px]"
      placeholder={t("monitor.sales.allStores")}
      searchPlaceholder={t("monitor.sales.storeSearch")}
      emptyMessage={t("monitor.customer.empty")}
    />
  );
  return (
    <SalesStatus
      days={stores.map((s) => s.day!)}
      titles={stores.map((s) => s.store.title)}
      conversion={
        store === null ? board.kpis.find((k) => k.id === "conversion") : null
      }
      picker={picker}
      // The sites' devices are the brand's, not one of its stores'.
      devices={canPickStore && store === null ? board.devices : null}
    />
  );
}

function Board({
  board,
  orgSlug,
  scopeId,
  today,
  selection,
  onSelect,
  ask,
  numbers,
  more,
}: {
  board: MonitorBoard;
  orgSlug: string;
  scopeId: string | null;
  /** A past day has no verdicts of its own, so it can't be all clear. */
  today: boolean;
  selection: MonitorSelection;
  onSelect: (selection: MonitorSelection) => void;
  ask: ReactNode;
  numbers: ReactNode;
  /** The sources still missing, last. */
  more: ReactNode;
}) {
  const signals = sortSignals(board.signals);
  return (
    <div className="flex flex-col gap-8">
      {ask}
      {signals.length > 0 ? (
        <SignalsPanel
          signals={signals}
          orgSlug={orgSlug}
          scopeId={scopeId}
          onOpenStore={(store) => onSelect({ ...selection, store })}
        />
      ) : (
        today && board.stores.length > 0 && <AllClear />
      )}
      <OverviewSales
        board={board}
        canPickStore={selection.customer !== "all"}
      />
      {numbers}
      {more}
    </div>
  );
}

export function MonitorPage({
  board,
  loading,
  error,
  orgSlug,
  scopeId: routeScope,
  orgWide = false,
  selection,
  onSelect,
}: {
  board: MonitorBoard;
  loading: boolean;
  error: Error | null;
  orgSlug: string;
  /** The project the route is in; null across the org. */
  scopeId: string | null;
  /** The route is in an agent that spans the org, not in a project. */
  orgWide?: boolean;
  selection: MonitorSelection;
  onSelect: (selection: MonitorSelection) => void;
}) {
  const t = useT();
  const projects = useSiteProjects();
  const scopeId = monitorScope(
    routeScope,
    projects,
    selection.project,
    orgWide,
  );
  const onProject = (project: string | null) =>
    onSelect({ view: selection.view, project: project ?? undefined });
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
  const day = selection.date ?? localDay(new Date());
  const today = day === localDay(new Date());
  const scopeProject = projects.find((p) => p.id === scopeId);
  const tabs = (
    <>
      <MonitorTabs
        view={view}
        onView={(next) =>
          onSelect({
            view: next === "metrics" ? undefined : next,
            project: selection.project,
          })
        }
      />
      {/* A customer's view isn't this org's projects; its stores filter the sales. */}
      {!routeScope && !selection.customer && projects.length > 1 && (
        <ProjectFilter
          projects={projects}
          value={scopeId}
          onChange={onProject}
        />
      )}
    </>
  );
  // Every tab but the Overview is its own screen, inside the one frame.
  if (view === "deploys") {
    const deploysState = stateOf("deploys");
    return (
      <MonitorFrame tabs={tabs}>
        {!loading && board.deploys && (
          <Page.Actions>
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
          </Page.Actions>
        )}
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 pt-6 pb-10 md:px-10">
          {loading ? (
            <Skeleton className="h-64" />
          ) : board.deploys ? (
            <DeploysView
              deploys={board.deploys}
              history={board.deployHistory}
              orgSlug={orgSlug}
              scopeId={scopeId}
            />
          ) : (
            <Locked
              kind="metrics"
              title={t("monitor.locked.deploys.title")}
              {...(deploysState === "partial"
                ? { guide: <MonitoredRepos /> }
                : { steps: [{ source: "deploys", state: deploysState }] })}
              link={connectLink(orgSlug, scopeId)}
            >
              <DeploysView
                deploys={[]}
                history={null}
                orgSlug={orgSlug}
                scopeId={scopeId}
              />
            </Locked>
          )}
        </div>
      </MonitorFrame>
    );
  }
  if (view === "alerts") {
    return (
      <MonitorFrame tabs={tabs}>
        <AlertsView
          orgSlug={orgSlug}
          stores={new Set(board.stores.map((s) => s.store.connectionId))}
          scoped={scopeId !== null}
          onOpenStore={(store) =>
            onSelect({ project: selection.project, store })
          }
        />
      </MonitorFrame>
    );
  }
  if (view === "experiments") {
    return (
      <MonitorFrame tabs={tabs}>
        <ExperimentsView scopeId={scopeId} />
      </MonitorFrame>
    );
  }
  if (view === "logs") {
    return (
      <MonitorFrame tabs={tabs}>
        <LogsView scopeId={scopeId} onProject={onProject} />
      </MonitorFrame>
    );
  }
  if (view === "audience") {
    return (
      <MonitorFrame tabs={tabs}>
        <AudienceView
          scopeId={scopeId}
          onOpen={(next) =>
            onSelect({ view: selection.view, project: next.project })
          }
        />
      </MonitorFrame>
    );
  }
  if (view === "heatmap") {
    return (
      <MonitorFrame tabs={tabs}>
        <MonitorHeatmap scopeId={scopeId} onProject={onProject} />
      </MonitorFrame>
    );
  }
  if (view === "performance") {
    return (
      <MonitorFrame tabs={tabs}>
        <PerformanceView scopeId={scopeId} onProject={onProject} />
      </MonitorFrame>
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
  if (selection.store) {
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
        <Skeleton className="h-14 rounded-full" />
        <Skeleton className="h-32" />
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
          (source) => ({
            source,
            state: stateOf(source),
          }),
        )}
        link={connectLink(orgSlug, scopeId)}
      >
        <NumberCards
          numbers={PREVIEW_NUMBERS.map((n) => ({
            key: n.key,
            label: t(n.label),
            help: t(n.label),
            value: n.value,
            chart: <Sparkline values={PREVIEW_SHAPE} className="h-14" />,
          }))}
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
        today={today}
        onSelect={onSelect}
        ask={
          // Asking reads your own org's data, not the customer's.
          selection.customer ? null : (
            <AskData project={scopeProject?.title ?? null} />
          )
        }
        numbers={
          <OverviewNumbers
            project={scopeProject}
            today={today}
            kpis={board.kpis}
            deploys={board.deploys}
            dayStart={board.dayStart}
            sales={board.stores.length > 0 && board.stores.every((s) => s.day)}
          />
        }
        more={
          !selection.customer && (
            <ConnectMore
              steps={(["orders", "analytics", "site", "deploys"] as const).map(
                (source) => ({
                  source,
                  state: stateOf(source),
                  // On the Overview a store is what alerts come from.
                  meta:
                    source === "orders"
                      ? t("monitor.connect.ordersAlerts")
                      : undefined,
                }),
              )}
              link={connectLink(orgSlug, scopeId)}
            />
          )
        }
      />
    );
  }
  // A store's day keeps the day picker.
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
      }
    : null;

  // The board analytics' frame: same width, gutters and rhythm.
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      {tabs}
      <Actions
        controls={controls}
        customer={
          view === "metrics" && (
            <MonitorOrgPicker
              orgSlug={orgSlug}
              value={selection.customer}
              onChange={(customer) => onSelect({ view: "metrics", customer })}
            />
          )
        }
      />
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 pt-6 pb-10 md:px-10">
        {body}
      </div>
    </div>
  );
}

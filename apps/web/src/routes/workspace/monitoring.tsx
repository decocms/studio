/**
 * Monitor, at org and project scope. It reads what is wired (the order
 * monitor, the projects' sites and repositories, the org's connections).
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChatLayout } from "@/components/chat-layout";
import {
  MonitorPage,
  type MonitorSelection,
} from "@/components/monitor/monitor-page";
import { SEGMENT_SEARCH_KEYS } from "@/components/monitor/analytics/segment";
import {
  MONITOR_VIEWS,
  type MonitorView,
  useSiteProjects,
} from "@/components/monitor/monitor-views";
import { MonitorOrgContext } from "@/components/monitor/monitor-org-context";
import { useLiveBoard } from "@/components/monitor/use-live-board";
import {
  DESTINATION_ROUTE,
  PROJECT_ROUTE,
} from "@/hooks/use-destination-route";
import { useScopeId } from "@/hooks/use-project-scope";
import { isScopableProject } from "@decocms/shared/sdk";
import { useProjectContext } from "@/sdk";

function useMonitorSearch(): MonitorSelection {
  const search = useSearch({ strict: false });
  const requested =
    "view" in search && typeof search.view === "string"
      ? search.view
      : undefined;
  const section =
    "section" in search && typeof search.section === "string"
      ? search.section
      : undefined;
  const view =
    requested === "audience" && section
      ? movedSection(section)
      : requested
        ? movedView(requested)
        : undefined;
  return {
    view,
    date:
      "date" in search && typeof search.date === "string"
        ? search.date
        : undefined,
    store:
      "store" in search && typeof search.store === "string"
        ? search.store
        : undefined,
    at: "at" in search && typeof search.at === "string" ? search.at : undefined,
    project:
      "project" in search && typeof search.project === "string"
        ? search.project
        : undefined,
    customer:
      "customer" in search && typeof search.customer === "string"
        ? search.customer
        : undefined,
  };
}

/** Tabs that were folded into others; ones that left the Monitor open the Overview. */
function movedView(view: string): MonitorView | undefined {
  // `analytics` was the CDN tab's name before it became Performance.
  if (view === "analytics") return "performance";
  if (view === "errors") return "logs";
  if (view === "realtime" || view === "pages" || view === "events") {
    return "audience";
  }
  return MONITOR_VIEWS.find((v) => v === view);
}

/** Analytics links from when its sections had tabs of their own. */
function movedSection(section: string): MonitorView {
  if (section === "heatmap") return "heatmap";
  if (section === "errors") return "logs";
  if (section === "vitals") return "performance";
  return "audience";
}

/** The Analytics segment's search keys, as they are. */
function useSegmentSearch(): Record<string, unknown> {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  return Object.fromEntries(
    SEGMENT_SEARCH_KEYS.flatMap((k) =>
      search[k] === undefined ? [] : [[k, search[k]]],
    ),
  );
}

function LiveMonitoring({
  orgSlug,
  scopeId,
  orgWide,
  selection,
  onSelect,
}: {
  orgSlug: string;
  scopeId: string | null;
  orgWide: boolean;
  selection: MonitorSelection;
  onSelect: (selection: MonitorSelection) => void;
}) {
  // The filter's pick narrows the whole board, its totals included; another
  // org's board has none of your projects to narrow by.
  const picked = useSiteProjects().some((p) => p.id === selection.project)
    ? selection.project
    : undefined;
  const { board, loading, error } = useLiveBoard(
    orgSlug,
    selection.customer ? null : (scopeId ?? picked ?? null),
    selection.date,
  );
  return (
    <MonitorPage
      board={board}
      loading={loading}
      error={error}
      orgSlug={orgSlug}
      scopeId={scopeId}
      orgWide={orgWide}
      selection={selection}
      onSelect={onSelect}
    />
  );
}

function MonitoringContent() {
  const { org } = useProjectContext();
  const routeId = useScopeId();
  // The Super Agent's route is org-wide: it owns no store or site.
  const scopeId =
    routeId && isScopableProject({ id: routeId }) ? routeId : null;
  const navigate = useNavigate();
  const selection = useMonitorSearch();
  const segment = useSegmentSearch();

  const onSelect = (selected: MonitorSelection) => {
    // Filters only make sense within one project's Analytics sections.
    const picked =
      selected.view === "audience" &&
      selection.view === "audience" &&
      selected.project === selection.project
        ? { ...selected, ...segment }
        : selected;
    // The customer sticks until the picker changes it.
    const next =
      "customer" in selected
        ? picked
        : { ...picked, customer: selection.customer };
    if (routeId) {
      void navigate({
        to: PROJECT_ROUTE.monitoring,
        params: { org: org.slug, agentId: routeId },
        search: next,
      });
    } else {
      void navigate({
        to: DESTINATION_ROUTE.monitoring,
        params: { org: org.slug },
        search: next,
      });
    }
  };

  // Another org's numbers are the Overview's only: the other tabs read your own.
  const customer =
    (selection.view ?? "metrics") === "metrics"
      ? selection.customer
      : undefined;
  return (
    <MonitorOrgContext.Provider value={customer}>
      <LiveMonitoring
        orgSlug={org.slug}
        scopeId={scopeId}
        orgWide={routeId !== null && scopeId === null}
        selection={{ ...selection, customer }}
        onSelect={onSelect}
      />
    </MonitorOrgContext.Provider>
  );
}

/**
 * Monitor only reads: a Blocks (v8) site's tests are edited and published in
 * its Experiments app, so there is no draft bar here.
 */
export default function MonitoringRoute() {
  return (
    <ChatLayout.Content>
      <MonitoringContent />
    </ChatLayout.Content>
  );
}

/**
 * Monitor, at org and project scope. It reads what is wired (the order
 * monitor, the projects' sites and repositories, the org's connections). Only
 * the new navigation announces it, so anyone else lands on home.
 */

import { Navigate, useNavigate, useSearch } from "@tanstack/react-router";
import { ChatLayout } from "@/components/chat-layout";
import {
  MonitorPage,
  type MonitorSelection,
} from "@/components/monitor/monitor-page";
import { MONITOR_VIEWS } from "@/components/monitor/monitor-views";
import { useLiveBoard } from "@/components/monitor/use-live-board";
import {
  DESTINATION_ROUTE,
  PROJECT_ROUTE,
} from "@/hooks/use-destination-route";
import { useProjectFirstNav } from "@/hooks/use-preferences";
import { useScopeId } from "@/hooks/use-project-scope";
import { useProjectContext } from "@/sdk";

function useMonitorSearch(): MonitorSelection {
  const search = useSearch({ strict: false });
  // `analytics` was the CDN tab's name before it became Performance.
  const requested =
    "view" in search && search.view === "analytics"
      ? "performance"
      : "view" in search
        ? search.view
        : undefined;
  const view =
    typeof requested === "string"
      ? MONITOR_VIEWS.find((v) => v === requested)
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
    site:
      "site" in search && typeof search.site === "string"
        ? search.site
        : undefined,
  };
}

function LiveMonitoring({
  orgSlug,
  scopeId,
  selection,
  onSelect,
}: {
  orgSlug: string;
  scopeId: string | null;
  selection: MonitorSelection;
  onSelect: (selection: MonitorSelection) => void;
}) {
  const { board, loading, error } = useLiveBoard(
    orgSlug,
    scopeId,
    selection.date,
  );
  return (
    <MonitorPage
      board={board}
      loading={loading}
      error={error}
      orgSlug={orgSlug}
      scopeId={scopeId}
      selection={selection}
      onSelect={onSelect}
    />
  );
}

function MonitoringContent() {
  const { org } = useProjectContext();
  const scopeId = useScopeId();
  const navigate = useNavigate();
  const projectFirstNav = useProjectFirstNav();
  const selection = useMonitorSearch();

  if (!projectFirstNav) {
    return <Navigate to="/$org/home" params={{ org: org.slug }} replace />;
  }

  const onSelect = (next: MonitorSelection) => {
    if (scopeId) {
      void navigate({
        to: PROJECT_ROUTE.monitoring,
        params: { org: org.slug, agentId: scopeId },
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

  return (
    <LiveMonitoring
      orgSlug={org.slug}
      scopeId={scopeId}
      selection={selection}
      onSelect={onSelect}
    />
  );
}

export default function MonitoringRoute() {
  return (
    <ChatLayout.Content>
      <MonitoringContent />
    </ChatLayout.Content>
  );
}

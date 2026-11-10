/** The Monitor's tabs: Overview, Performance, Logs, Analytics and Heatmap. */

import type { ReactNode } from "react";
import { BarChart10 } from "@untitledui/icons";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import {
  resolveAgentSiteSlug,
  resolveAnalyticsSiteSlug,
} from "@decocms/shared/site-slug";
import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
import { useControlPlaneViews } from "@/hooks/use-organization-settings";
import { usePublicConfig } from "@/hooks/use-public-config";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import {
  isStudioPackAgent,
  useProjectContext,
  useVirtualMCPsNonBlocking,
} from "@/sdk";
import { type AnalyticsTarget, AudienceScreen } from "./audience-view";
import { HeatmapScreen } from "./deco-stack";
import { PerformanceScreen } from "./performance-view";
import { AnalyticsGuide, AnalyticsPreview, Locked } from "./locked";
import type { SiteProject } from "./org-insights";
import { connectLink } from "./parts";

export type MonitorView =
  | "metrics"
  | "performance"
  | "logs"
  | "deploys"
  | "experiments"
  | "audience"
  | "heatmap";
export const MONITOR_VIEWS: readonly MonitorView[] = [
  "metrics",
  "performance",
  "logs",
  "deploys",
  "experiments",
  "audience",
  "heatmap",
];

function viewLabel(view: MonitorView, t: TFunction): string {
  switch (view) {
    case "metrics":
      return t("monitor.view.metrics");
    case "performance":
      return t("monitor.view.performance");
    case "logs":
      return t("monitor.view.logs");
    case "deploys":
      return t("monitor.view.deploys");
    case "experiments":
      return t("monitor.view.experiments");
    case "audience":
      return t("monitor.view.audience");
    case "heatmap":
      return t("monitor.view.heatmap");
    default: {
      const unhandled: never = view;
      return unhandled;
    }
  }
}

/** In the panel's toolbar, where the task board puts Feed / Board / List. */
export function MonitorTabs({
  view,
  onView,
}: {
  view: MonitorView;
  onView: (view: MonitorView) => void;
}) {
  const t = useT();
  const tabs = (
    <Page.Tabs>
      {MONITOR_VIEWS.map((v) => (
        <Page.Tab key={v} active={view === v} onClick={() => onView(v)}>
          {viewLabel(v, t)}
        </Page.Tab>
      ))}
    </Page.Tabs>
  );
  return (
    <Panel.Toolbar.Left.Portal fallback={tabs}>
      {tabs}
    </Panel.Toolbar.Left.Portal>
  );
}

/** The org's own projects with a site, not Studio's built-in managers. */
export function useSiteProjects(): SiteProject[] {
  return useVirtualMCPsNonBlocking().flatMap((p) => {
    // The Deco Score Agent is built in, not a site, even when it's bound to the
    // store's repository.
    const builtIn =
      isStudioPackAgent(p.id) || p.metadata?.type === "commerce-discovery";
    const site = builtIn ? null : resolveAgentSiteSlug(p);
    const analyticsSite = resolveAnalyticsSiteSlug(p);
    return site && analyticsSite
      ? [
          {
            id: p.id,
            title: p.title,
            icon: p.icon,
            site,
            analyticsSite,
            repository: p.metadata?.repository ?? null,
          },
        ]
      : [];
  });
}

/** One project's screen, or every site project's across the org; the connect card when none. */
export function ProjectScreen({
  scopeId,
  enabled,
  children,
}: {
  scopeId: string | null;
  /** The org has this screen on at all. */
  enabled: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const projects = useSiteProjects();
  if (!enabled || (!scopeId && projects.length === 0)) {
    return (
      <div className="px-4 pt-6 pb-10 md:px-10">
        <Locked
          kind="analytics"
          title={t("monitor.locked.analytics.title")}
          guide={<AnalyticsGuide />}
          link={connectLink(org.slug, scopeId)}
        >
          <AnalyticsPreview />
        </Locked>
      </div>
    );
  }
  if (!scopeId) return children;
  return (
    <div key={scopeId} className="flex h-full min-h-0 flex-col">
      {children}
    </div>
  );
}

/** A project route on an agent without a site: nothing to read, and no other project to pick. */
export function NoSite() {
  const t = useT();
  return (
    <EmptyState
      icon={<BarChart10 size={20} />}
      title={t("mainPanelTabs.cdnTab.noSiteTitle")}
    />
  );
}

/** Requests, cache and errors: the CDN on v7 sites, the site's own telemetry on v8. */
export function PerformanceView({
  scopeId,
  onProject,
}: {
  scopeId: string | null;
  onProject: (projectId: string) => void;
}) {
  const views = useControlPlaneViews();
  const config = usePublicConfig();
  const projects = useSiteProjects();
  return (
    <ProjectScreen
      scopeId={scopeId}
      enabled={
        views.monitor &&
        (config.monitorEnabled === true || config.auth.localMode === true)
      }
    >
      <PerformanceScreen
        projects={projects}
        scopeId={scopeId}
        onProject={onProject}
      />
    </ProjectScreen>
  );
}

/** Where visitors click and scroll, one project's page at a time. */
export function MonitorHeatmap({
  scopeId,
  onProject,
}: {
  scopeId: string | null;
  onProject: (projectId: string) => void;
}) {
  const views = useControlPlaneViews();
  const projects = useSiteProjects();
  const project = projects.find((p) => p.id === scopeId);
  return (
    <ProjectScreen scopeId={scopeId} enabled={views.monitor}>
      {scopeId && !project ? (
        <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-10 md:px-10">
          <NoSite />
        </div>
      ) : (
        <HeatmapScreen
          project={project}
          projects={projects}
          onProject={onProject}
        />
      )}
    </ProjectScreen>
  );
}

/** Who visits, from Deco Analytics or OneDollarStats, one shape for both. */
export function AudienceView({
  scopeId,
  onOpen,
}: {
  scopeId: string | null;
  onOpen: (next: AnalyticsTarget) => void;
}) {
  const views = useControlPlaneViews();
  const projects = useSiteProjects();
  return (
    <ProjectScreen scopeId={scopeId} enabled={views.monitor}>
      <AudienceScreen projects={projects} scopeId={scopeId} onOpen={onOpen} />
    </ProjectScreen>
  );
}

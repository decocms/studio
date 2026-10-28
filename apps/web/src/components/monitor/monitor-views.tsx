/**
 * The Monitor's views, switched like the task board's Feed / Board / List:
 * Metrics (is today normal), Deploys (what changed and what it did),
 * Experiments and Analytics. Inside a project, Experiments and Analytics are
 * that project's own screens; across the org they add every site up.
 */

import type { ReactNode } from "react";
import {
  isValidSiteSlug,
  resolveAgentSiteSlug,
  resolveAnalyticsSiteSlug,
} from "@decocms/shared/site-slug";
import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
import { useControlPlaneViews } from "@/hooks/use-organization-settings";
import { usePublicConfig } from "@/hooks/use-public-config";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { CdnTab } from "@/layouts/main-panel-tabs/cdn-tab";
import { ExperimentsTab } from "@/layouts/main-panel-tabs/experiments-tab";
import { MetricCard } from "@/layouts/task-board/analytics-sections";
import {
  isStudioPackAgent,
  useProjectContext,
  useVirtualMCPsNonBlocking,
} from "@/sdk";
import type { Deploy } from "./board";
import { DeployTimeline } from "./deploy-timeline";
import { DeploysTable } from "./deploys-table";
import {
  AnalyticsGuide,
  AnalyticsPreview,
  ExperimentsPreview,
  Locked,
} from "./locked";
import { monitorPreview } from "./preview";
import { OrgAnalytics, OrgExperiments, type SiteProject } from "./org-insights";
import { connectLink } from "./parts";

export type MonitorView = "metrics" | "deploys" | "experiments" | "analytics";
export const MONITOR_VIEWS: readonly MonitorView[] = [
  "metrics",
  "deploys",
  "experiments",
  "analytics",
];

function viewLabel(view: MonitorView, t: TFunction): string {
  switch (view) {
    case "metrics":
      return t("monitor.view.metrics");
    case "deploys":
      return t("monitor.view.deploys");
    case "experiments":
      return t("monitor.view.experiments");
    case "analytics":
      return t("monitor.view.analytics");
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

export function DeploysView({
  deploys,
  history,
  orgSlug,
  scopeId,
}: {
  deploys: readonly Deploy[];
  history: readonly Deploy[] | null;
  orgSlug: string;
  scopeId: string | null;
}) {
  const t = useT();
  const regressions = deploys.filter((d) => d.verdict === "regression").length;
  const measuring = deploys.filter((d) => d.verdict === "settling").length;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard title={t("monitor.deploys.title")} value={deploys.length} />
        <MetricCard
          title={t("monitor.deploys.regressions")}
          value={regressions}
          caption={
            regressions > 0 && (
              <span className="text-meta text-destructive">
                {t("monitor.deploys.regressionsHint")}
              </span>
            )
          }
        />
        <MetricCard
          title={t("monitor.deploys.measuringCount")}
          value={measuring}
        />
      </div>
      {history && <DeployTimeline deploys={history} showProject={!scopeId} />}
      <div className="mt-6">
        <DeploysTable
          deploys={deploys}
          orgSlug={orgSlug}
          showProject={!scopeId}
        />
      </div>
    </div>
  );
}

/** The preview's experiments, for the faded tab behind its connect panel. */
const PREVIEW_EXPERIMENTS = monitorPreview(null).experiments;

/** The org's own projects with a site, not Studio's built-in managers. */
function useSiteProjects(): SiteProject[] {
  return useVirtualMCPsNonBlocking().flatMap((p) => {
    const site = isStudioPackAgent(p.id) ? null : resolveAgentSiteSlug(p);
    const analyticsSite = resolveAnalyticsSiteSlug(p);
    // Agents with no site of their own fall back to their title ("Deco Score
    // Agent"), which no site can be named.
    return site && isValidSiteSlug(site) && analyticsSite
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

/**
 * A project's own screen inside a project; across the org, the org's view of
 * every site project at once.
 */
function ProjectScreen({
  scopeId,
  enabled,
  empty,
  render,
  org,
}: {
  scopeId: string | null;
  /** The org has this screen on at all. */
  enabled: boolean;
  /** Which tab to draw, faded, when there is no site to read. */
  empty: "experiments" | "analytics";
  render: (projectId: string) => ReactNode;
  org: (projects: readonly SiteProject[]) => ReactNode;
}) {
  const t = useT();
  const { org: organization } = useProjectContext();
  const projects = useSiteProjects();
  if (!enabled || (!scopeId && projects.length === 0)) {
    return (
      <div className="px-4 pt-6 pb-10 md:px-10">
        <Locked
          kind={empty}
          title={
            empty === "analytics"
              ? t("monitor.locked.analytics.title")
              : t("monitor.locked.experiments.title")
          }
          {...(empty === "analytics"
            ? { guide: <AnalyticsGuide /> }
            : {
                steps: [
                  {
                    source: "site",
                    state: "off",
                    meta: t("monitor.powers.siteExperiments"),
                  },
                ],
              })}
          link={connectLink(organization.slug, scopeId)}
        >
          {empty === "analytics" ? (
            <AnalyticsPreview />
          ) : (
            <ExperimentsPreview experiments={PREVIEW_EXPERIMENTS} />
          )}
        </Locked>
      </div>
    );
  }
  if (!scopeId) {
    // The board's frame: same width, gutters and rhythm as Metrics.
    return (
      <div className="flex h-full min-h-0 flex-col overflow-auto">
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 pt-6 pb-10 md:px-10">
          {org(projects)}
        </div>
      </div>
    );
  }
  return (
    <div key={scopeId} className="flex h-full min-h-0 flex-col">
      {render(scopeId)}
    </div>
  );
}

/** Thais's rebuilt Experiments where the org has it, through the tab's own pick. */
export function ExperimentsView({ scopeId }: { scopeId: string | null }) {
  const views = useControlPlaneViews();
  return (
    <ProjectScreen
      scopeId={scopeId}
      enabled={views.experiments}
      empty="experiments"
      render={(id) => <ExperimentsTab virtualMcpId={id} />}
      org={(projects) => <OrgExperiments projects={projects} />}
    />
  );
}

/** A site's Monitor (CDN traffic and audience), gated as its own route is. */
export function AnalyticsView({
  scopeId,
  date,
  onDate,
}: {
  scopeId: string | null;
  /** The org view's day, shared with Metrics' picker (`YYYY-MM-DD`). */
  date: string;
  onDate: (date: string) => void;
}) {
  const views = useControlPlaneViews();
  const config = usePublicConfig();
  return (
    <ProjectScreen
      scopeId={scopeId}
      enabled={
        views.monitor &&
        (config.monitorEnabled === true || config.auth.localMode === true)
      }
      empty="analytics"
      render={(id) => <CdnTab virtualMcpId={id} />}
      org={(projects) => (
        <OrgAnalytics projects={projects} date={date} onDate={onDate} />
      )}
    />
  );
}

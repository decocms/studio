/**
 * Experiments and Analytics across the org: every site project read at once
 * and laid side by side, each line opening that project's own screen. Inside
 * a project the Monitor shows the project's screens as they are; this is only
 * the org's view of them.
 */

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import { Card } from "@decocms/ui/components/card.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Panel } from "@/components/panel";
import { ProjectIcon } from "@/components/project-icon";
import { type Experiment, experimentsQuery } from "@/hooks/use-experiments";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import {
  type CdnSummary,
  fetchJson,
  RangePicker,
  type RangeSel,
  type TimelinePoint,
} from "@/layouts/main-panel-tabs/cdn-tab";
import { ExperimentRow } from "@/layouts/main-panel-tabs/experiments-tab";
import { useProjectContext } from "@/sdk";
import { connectLink, projectLink } from "./parts";
import {
  AnalyticsGuide,
  AnalyticsPreview,
  ExperimentsPreview,
  Locked,
} from "./locked";
import { monitorPreview } from "./preview";
import { SitesMonitor, sumSummaries, sumTimelines } from "./sites-monitor";

/** A project with a site, as the org views read it. */
export interface SiteProject {
  id: string;
  title: string;
  icon: string | null | undefined;
  /** The site its experiments live under. */
  site: string;
  /** The site its traffic is reported under, which a migration may override. */
  analyticsSite: string;
}

function ProjectName({ project }: { project: SiteProject }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <ProjectIcon icon={project.icon} name={project.title} />
      <span className="truncate">{project.title}</span>
    </span>
  );
}

/** The org's names for projects it couldn't read, said once and quietly. */
function Unreadable({ projects }: { projects: readonly SiteProject[] }) {
  const t = useT();
  if (projects.length === 0) return null;
  return (
    <p className="px-2 pb-1 text-meta">
      {t("monitor.org.unreadable", {
        names: projects.map((p) => p.title).join(", "),
      })}
    </p>
  );
}

// --- experiments -------------------------------------------------------------

/** Running first, then whatever moved last. */
function byRunningThenRecent(
  a: { experiment: Experiment },
  b: { experiment: Experiment },
): number {
  const running =
    Number(b.experiment.status === "running") -
    Number(a.experiment.status === "running");
  return (
    running ||
    Date.parse(b.experiment.updatedAt) - Date.parse(a.experiment.updatedAt)
  );
}

export function OrgExperiments({
  projects,
}: {
  projects: readonly SiteProject[];
}) {
  const t = useT();
  const { org, locator } = useProjectContext();
  const studio = useStudioTools();
  const navigate = useNavigate();
  const results = useQueries({
    queries: projects.map((p) => ({
      ...experimentsQuery(locator, studio, p.site),
      retry: false,
    })),
  });

  const loading = results.some((r) => r.isLoading);
  const failed = projects.filter((_, i) => results[i]?.isError);
  const rows = projects
    .flatMap((project, i) =>
      (results[i]?.data ?? []).map((experiment) => ({ project, experiment })),
    )
    .sort(byRunningThenRecent);

  if (!loading && rows.length === 0 && failed.length === 0) {
    return (
      <Locked
        kind="experiments"
        title={t("monitor.locked.firstExperiment.title")}
        steps={[
          {
            source: "site",
            state: "off",
            meta: t("monitor.powers.siteExperiments"),
            label: t("monitor.connect.firstExperiment"),
            link: projectLink(org.slug, projects[0]?.id ?? "", "experiments"),
          },
        ]}
        link={projectLink(org.slug, projects[0]?.id ?? "", "experiments")}
      >
        <ExperimentsPreview experiments={monitorPreview(null).experiments} />
      </Locked>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Card
        size="flush"
        className="gap-0 divide-y divide-border overflow-hidden"
      >
        {loading && rows.length === 0 && (
          <div className="flex flex-col gap-3 px-5 py-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        )}
        {rows.map(({ project, experiment }) => (
          <ExperimentRow
            key={`${project.id}:${experiment.id}`}
            experiment={experiment}
            onOpen={() =>
              navigate(projectLink(org.slug, project.id, "experiments"))
            }
            project={<ProjectName project={project} />}
          />
        ))}
      </Card>
      <Unreadable projects={failed} />
    </div>
  );
}

// --- analytics ---------------------------------------------------------------

/** One site's Performance read, as the project's Monitor reads it. */
function monitorQuery(
  base: string,
  view: "summary" | "timeline",
  sel: RangeSel,
) {
  const extra =
    sel.range === "custom" ? `&since=${sel.since}&until=${sel.until}` : "";
  return {
    // The project's own Monitor reads this same key, so they share a cache.
    queryKey: KEYS.cdnData(base, `cdn:${view}${extra}`, sel.range),
    queryFn: async () => {
      const body = (await fetchJson(
        `${base}/cdn/data?view=${view}&range=${sel.range}${extra}`,
      )) as { available?: boolean; data?: unknown };
      return body.available === false ? null : (body.data ?? null);
    },
    retry: false,
    staleTime: 30_000,
  };
}

const DEFAULT_RANGE: RangeSel = {
  range: "7d",
  since: "",
  until: "",
  compare: false,
};

/**
 * Every site's Monitor at once: the same Performance numbers, summed. Only
 * sites the CDN reports for count; a project that is not a deco site simply
 * has none, so it never shows as a gap.
 */
export function OrgAnalytics({
  projects,
}: {
  projects: readonly SiteProject[];
}) {
  const t = useT();
  const { org } = useProjectContext();
  const [sel, setSel] = useState<RangeSel>(DEFAULT_RANGE);
  const bases = projects.map(
    (p) => `/api/${org.slug}/monitor/${encodeURIComponent(p.analyticsSite)}`,
  );
  const summaries = useQueries({
    queries: bases.map((base) => monitorQuery(base, "summary", sel)),
  });
  const timelines = useQueries({
    queries: bases.map((base) => monitorQuery(base, "timeline", sel)),
  });

  const loading = summaries.some((r) => r.isLoading);
  const sites = projects.flatMap((project, i) => {
    const summary = summaries[i]?.data as CdnSummary | null | undefined;
    return summary && summary.total_requests > 0
      ? [{ project, summary, timeline: timelines[i]?.data }]
      : [];
  });
  sites.sort((a, b) => b.summary.total_requests - a.summary.total_requests);

  const picker = <RangePicker value={sel} onChange={setSel} />;

  if (!loading && sites.length === 0) {
    return (
      <Locked
        kind="analytics"
        title={t("monitor.locked.analytics.title")}
        guide={<AnalyticsGuide />}
        link={connectLink(org.slug, null)}
      >
        <AnalyticsPreview />
      </Locked>
    );
  }

  return (
    <>
      <Panel.Toolbar.Right.Portal fallback={picker}>
        {picker}
      </Panel.Toolbar.Right.Portal>
      <SitesMonitor
        loading={loading}
        summary={
          sites.length > 0 ? sumSummaries(sites.map((s) => s.summary)) : null
        }
        timeline={sumTimelines(
          sites.map((s) => (s.timeline as TimelinePoint[] | null) ?? []),
        )}
        sites={sites.map(({ project, summary }) => ({
          id: project.id,
          name: <ProjectName project={project} />,
          summary,
          link: projectLink(org.slug, project.id, "analytics"),
        }))}
      />
    </>
  );
}

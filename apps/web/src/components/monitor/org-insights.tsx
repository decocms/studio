/**
 * Experiments and Analytics across the org: every site project read at once
 * and laid side by side, each line opening that project's own screen. Inside
 * a project the Monitor shows the project's screens as they are; this is only
 * the org's view of them.
 */

import { useNavigate } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import { Card } from "@decocms/ui/components/card.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { DayInput } from "@/components/order-monitor/order-monitor-day";
import { Page } from "@/components/page";
import { ProjectIcon } from "@/components/project-icon";
import { type Experiment, experimentsQuery } from "@/hooks/use-experiments";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import {
  type CdnSummary,
  fetchJson,
  type TimelinePoint,
} from "@/layouts/main-panel-tabs/cdn-tab";
import { ExperimentRow } from "@/layouts/main-panel-tabs/experiments-tab";
import { useProjectContext } from "@/sdk";
import { connectLink, localDay, projectLink } from "./parts";
import {
  AnalyticsGuide,
  AnalyticsPreview,
  ExperimentsPreview,
  Locked,
} from "./locked";
import { monitorPreview } from "./preview";
import {
  SitesMonitor,
  SitesMonitorSkeleton,
  sumSummaries,
  sumTimelines,
} from "./sites-monitor";

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

const DAY_MS = 86_400_000;

/** The same weekday a week before, as Metrics compares against. */
const weekBefore = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - 7 * DAY_MS)
    .toISOString()
    .slice(0, 10);

/** One calendar day, read hourly. */
const oneDay = (date: string) => `&since=${date}&until=${date}`;

/** One site's Performance read, as the project's Monitor reads it. */
function monitorQuery(
  base: string,
  view: "summary" | "timeline",
  range: string,
  extra: string,
) {
  return {
    // The project's own Monitor reads this same key, so they share a cache.
    queryKey: KEYS.cdnData(base, `cdn:${view}${extra}`, range),
    queryFn: async () => {
      const body = (await fetchJson(
        `${base}/cdn/data?view=${view}&range=${range}${extra}`,
      )) as { available?: boolean; data?: unknown };
      return body.available === false ? null : (body.data ?? null);
    },
    retry: false,
    staleTime: 30_000,
  };
}

const asSummary = (data: unknown) => (data ?? null) as CdnSummary | null;
const asTimeline = (data: unknown) =>
  Array.isArray(data) ? (data as TimelinePoint[]) : [];

/**
 * Every site's Monitor at once, laid out like the Metrics board: the same
 * Performance numbers summed, for the day Metrics is on, against the same
 * day a week before. Only sites the CDN
 * reports for count; a project that is not a deco site simply has none, so it
 * never shows as a gap.
 */
export function OrgAnalytics({
  projects,
  date,
  onDate,
}: {
  projects: readonly SiteProject[];
  date: string;
  onDate: (date: string) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const today = localDay(new Date());
  const bases = projects.map(
    (p) => `/api/${org.slug}/monitor/${encodeURIComponent(p.analyticsSite)}`,
  );
  const read = (view: "summary" | "timeline", previous: boolean) =>
    bases.map((base) =>
      monitorQuery(
        base,
        view,
        "custom",
        oneDay(previous ? weekBefore(date) : date),
      ),
    );
  const summaries = useQueries({ queries: read("summary", false) });
  const timelines = useQueries({ queries: read("timeline", false) });
  const previousSummaries = useQueries({ queries: read("summary", true) });
  const previousTimelines = useQueries({ queries: read("timeline", true) });

  const loading = summaries.some((r) => r.isLoading);
  const sites = projects
    .flatMap((project, i) => {
      const summary = asSummary(summaries[i]?.data);
      if (!summary || summary.total_requests <= 0) return [];
      return [
        {
          project,
          summary,
          previous: asSummary(previousSummaries[i]?.data),
          timeline: asTimeline(timelines[i]?.data),
          previousTimeline: asTimeline(previousTimelines[i]?.data),
        },
      ];
    })
    .sort((a, b) => b.summary.pageviews - a.summary.pageviews);

  const actions = (
    <Page.Actions>
      <DayInput value={date} max={today} onChange={onDate} />
    </Page.Actions>
  );

  if (loading) {
    return (
      <>
        {actions}
        <SitesMonitorSkeleton />
      </>
    );
  }
  if (sites.length === 0) {
    return (
      <Locked
        kind="analytics"
        title={t("monitor.locked.analytics.title")}
        guide={<AnalyticsGuide projects={projects} />}
        link={connectLink(org.slug, null)}
      >
        <AnalyticsPreview />
      </Locked>
    );
  }

  // The period before only counts where every site answered for it.
  const previous = sites.every((s) => s.previous)
    ? sumSummaries(sites.flatMap((s) => (s.previous ? [s.previous] : [])))
    : null;
  return (
    <>
      {actions}
      <SitesMonitor
        data={{
          currentLabel:
            date === today
              ? t("monitor.chart.today")
              : new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                }),
          summary: sumSummaries(sites.map((s) => s.summary)),
          previous,
          timeline: sumTimelines(sites.map((s) => s.timeline)),
          previousTimeline: sumTimelines(sites.map((s) => s.previousTimeline)),
          sites: sites.map((s) => ({
            id: s.project.id,
            name: <ProjectName project={s.project} />,
            summary: s.summary,
            previous: s.previous,
            series: s.timeline.map((p) => p.pageviews),
            previousSeries: s.previousTimeline.map((p) => p.pageviews),
            link: projectLink(org.slug, s.project.id, "analytics"),
          })),
        }}
      />
    </>
  );
}

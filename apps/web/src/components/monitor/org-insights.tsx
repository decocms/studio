/**
 * Experiments and Analytics across the org: every site project read at once
 * and laid side by side, each line opening that project's own screen. Inside
 * a project the Monitor shows the project's screens as they are; this is only
 * the org's view of them.
 */

import type { RepositoryBinding } from "@decocms/shared/sdk/types";
import { useNavigate } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import { Plus } from "@untitledui/icons";
import { z } from "zod";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
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
  useInstallableProjects,
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
  /** Where its code lives, when the project has a repository linked. */
  repository: RepositoryBinding | null;
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

/** The Deco Analytics tag reports to its own collector, not the CDN warehouse,
 *  so a tagged site's pageviews come from the read the project's Analytics tab
 *  makes (same key, shared cache). */
// ponytail: the collector only reads rolling windows, so a day older than 7d
// shows no tag pageviews; ask it for a since/until window if that matters.
function collectorQuery(orgSlug: string, site: string) {
  return {
    queryKey: KEYS.analyticsData(orgSlug, site, "overview", "7d"),
    queryFn: () =>
      fetchJson(
        `/api/${orgSlug}/hosting/${encodeURIComponent(site)}/analytics/data?view=overview&range=7d`,
      ),
    retry: false,
    staleTime: 30_000,
  };
}

const CollectorOverview = z.object({
  data: z.object({
    // `t` is the UTC hour as ClickHouse prints it, the CDN buckets' format.
    series: z.array(z.object({ t: z.string(), pageviews: z.coerce.number() })),
  }),
});

/** The tag's hourly pageviews on one UTC day, as timeline points. */
function collectorDay(data: unknown, date: string): TimelinePoint[] {
  const parsed = CollectorOverview.safeParse(data);
  if (!parsed.success) return [];
  return parsed.data.data.series
    .filter((row) => row.t.startsWith(date))
    .map((row) => ({
      bucket: row.t,
      requests: 0,
      bandwidth_bytes: 0,
      pageviews: row.pageviews,
      cache_hit_ratio: 0,
    }));
}

/**
 * Every site's Monitor at once, laid out like the Metrics board: the same
 * Performance numbers summed, for the day Metrics is on, against the same
 * day a week before. Only sites the CDN or the analytics tag report for
 * count; a project with neither simply has none, so it never shows as a gap.
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
  const collectors = useQueries({
    queries: projects.map((p) => collectorQuery(org.slug, p.site)),
  });

  const loading =
    summaries.some((r) => r.isLoading) || collectors.some((r) => r.isLoading);
  const sites = projects
    .flatMap((project, i) => {
      const cdn = asSummary(summaries[i]?.data);
      const tag = collectorDay(collectors[i]?.data, date);
      const tagged = tag.reduce((n, p) => n + p.pageviews, 0);
      // The higher of the two, so a site counted by both isn't counted twice.
      const pageviews = Math.max(cdn?.pageviews ?? 0, tagged);
      if ((cdn?.total_requests ?? 0) <= 0 && pageviews <= 0) return [];
      return [
        {
          project,
          summary: { ...(cdn ?? sumSummaries([])), pageviews },
          // The tag's 7-day window has no week-before day to compare against.
          previous: tagged ? null : asSummary(previousSummaries[i]?.data),
          timeline: sumTimelines([asTimeline(timelines[i]?.data), tag]),
          previousTimeline: tagged
            ? []
            : asTimeline(previousTimelines[i]?.data),
        },
      ];
    })
    .sort((a, b) => b.summary.pageviews - a.summary.pageviews);
  // Serving traffic with no pageview counted means the site has no tag yet,
  // even when an older analytics registration exists for it.
  const uncounted = useInstallableProjects(
    sites.filter((s) => s.summary.pageviews === 0).map((s) => s.project),
  );

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
      <>
        {actions}
        <Locked
          kind="analytics"
          title={t("monitor.locked.analytics.title")}
          guide={<AnalyticsGuide projects={projects} />}
          link={connectLink(org.slug, null)}
        >
          <AnalyticsPreview />
        </Locked>
      </>
    );
  }

  // The period before only counts where every site answered for it.
  const previous = sites.every((s) => s.previous)
    ? sumSummaries(sites.flatMap((s) => (s.previous ? [s.previous] : [])))
    : null;
  const counted = new Set(
    sites.filter((s) => s.summary.pageviews > 0).map((s) => s.project.site),
  );
  return (
    <>
      <Page.Actions>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" className="gap-1">
              <Plus size={14} />
              {t("monitor.analyticsGuide.addAnother")}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-96">
            <AnalyticsGuide
              projects={projects.filter((p) => !counted.has(p.site))}
            />
          </PopoverContent>
        </Popover>
        <DayInput value={date} max={today} onChange={onDate} />
      </Page.Actions>
      {uncounted && uncounted.length > 0 && (
        <Card className="gap-3 p-5">
          <p className="text-sm font-medium text-foreground">
            {t("monitor.analyticsGuide.uncounted")}
          </p>
          <AnalyticsGuide projects={uncounted} />
        </Card>
      )}
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

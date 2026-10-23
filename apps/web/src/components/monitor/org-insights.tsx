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
import { Page } from "@/components/page";
import { ProjectIcon } from "@/components/project-icon";
import { type Experiment, experimentsQuery } from "@/hooks/use-experiments";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import {
  type CdnSummary,
  fetchJson,
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

/** The presets the org reads, as the site Monitor names them. */
const RANGES = ["today", "yesterday", "7d", "14d", "30d", "90d"] as const;
type Range = (typeof RANGES)[number];

/** Calendar days each preset spans, and how far its last day sits before today. */
const WINDOW: Record<Range, { days: number; endOffset: number }> = {
  today: { days: 1, endOffset: 0 },
  yesterday: { days: 1, endOffset: 1 },
  "7d": { days: 7, endOffset: 0 },
  "14d": { days: 14, endOffset: 0 },
  "30d": { days: 30, endOffset: 0 },
  "90d": { days: 90, endOffset: 0 },
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The same number of days just before the preset's window, as a custom range.
 * Dates are UTC, as the Monitor's own windows are.
 */
function previousWindow(range: Range): string {
  const { days, endOffset } = WINDOW[range];
  const until = new Date();
  until.setUTCDate(until.getUTCDate() - endOffset - days);
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  return `&since=${isoDay(since)}&until=${isoDay(until)}`;
}

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

function RangeSelect({
  value,
  onChange,
}: {
  value: Range;
  onChange: (range: Range) => void;
}) {
  const t = useT();
  const label = (range: Range) => {
    switch (range) {
      case "today":
        return t("mainPanelTabs.cdnTab.today");
      case "yesterday":
        return t("mainPanelTabs.cdnTab.yesterday");
      case "7d":
        return t("mainPanelTabs.cdnTab.last7d");
      case "14d":
        return t("mainPanelTabs.cdnTab.last14d");
      case "30d":
        return t("mainPanelTabs.cdnTab.last30d");
      case "90d":
        return t("mainPanelTabs.cdnTab.last90d");
      default: {
        const unhandled: never = range;
        return unhandled;
      }
    }
  };
  return (
    <Select value={value} onValueChange={(next) => onChange(next as Range)}>
      <SelectTrigger size="sm" className="w-[140px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {RANGES.map((range) => (
          <SelectItem key={range} value={range}>
            {label(range)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const asSummary = (data: unknown) => (data ?? null) as CdnSummary | null;
const asTimeline = (data: unknown) =>
  Array.isArray(data) ? (data as TimelinePoint[]) : [];

/**
 * Every site's Monitor at once, laid out like the Metrics board: the same
 * Performance numbers summed, against the period before. Only sites the CDN
 * reports for count; a project that is not a deco site simply has none, so it
 * never shows as a gap.
 */
export function OrgAnalytics({
  projects,
}: {
  projects: readonly SiteProject[];
}) {
  const t = useT();
  const { org } = useProjectContext();
  const [range, setRange] = useState<Range>("7d");
  const before = previousWindow(range);
  const bases = projects.map(
    (p) => `/api/${org.slug}/monitor/${encodeURIComponent(p.analyticsSite)}`,
  );
  const read = (view: "summary" | "timeline", previous: boolean) =>
    bases.map((base) =>
      previous
        ? monitorQuery(base, view, "custom", before)
        : monitorQuery(base, view, range, ""),
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
      <RangeSelect value={range} onChange={setRange} />
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
        guide={<AnalyticsGuide />}
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

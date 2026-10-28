/**
 * The Monitor's Audience tab: who visits the site, from whichever source the
 * site reports to (Deco Analytics, or OneDollarStats until it retires). One
 * shape for both — the server normalizes (`/api/:org/monitor/:site/audience`)
 * and says which source answered, which the tab shows as a badge.
 */

import { type ReactNode, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BarChart10 } from "@untitledui/icons";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type {
  AudienceRange,
  AudienceResponse,
  AudienceRow,
  AudienceSource,
  AudienceSummary,
  AudienceView,
} from "@decocms/shared/monitor-audience";
import { AUDIENCE_RANGES } from "@decocms/shared/monitor-audience";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { MetricCard } from "@/layouts/task-board/analytics-sections";
import { fetchJson, formatNumber } from "@/layouts/main-panel-tabs/cdn-tab";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import type { SiteProject } from "./org-insights";
import { projectLink } from "./parts";

const COLOR_VISITORS = "var(--chart-1)";

function useAudience(
  orgSlug: string,
  project: Pick<SiteProject, "site" | "analyticsSite">,
  view: AudienceView,
  range: AudienceRange,
) {
  return useQuery(audienceQuery(orgSlug, project, view, range));
}

function audienceQuery(
  orgSlug: string,
  project: Pick<SiteProject, "site" | "analyticsSite">,
  view: AudienceView,
  range: AudienceRange,
) {
  const params = new URLSearchParams({ view, range });
  if (project.analyticsSite !== project.site) {
    params.set("trafficSite", project.analyticsSite);
  }
  return {
    queryKey: KEYS.monitorAudience(
      orgSlug,
      project.site,
      project.analyticsSite,
      view,
      range,
    ),
    queryFn: async () =>
      (await fetchJson(
        `/api/${orgSlug}/monitor/${encodeURIComponent(project.site)}/audience?${params}`,
      )) as AudienceResponse,
    retry: false,
    staleTime: 60_000,
  };
}

function sourceLabel(source: AudienceSource, t: TFunction): string {
  switch (source) {
    case "deco-analytics":
      return t("monitor.audience.source.decoAnalytics");
    case "onedollar":
      return t("monitor.audience.source.onedollar");
    default: {
      const unhandled: never = source;
      return unhandled;
    }
  }
}

function rangeLabel(range: AudienceRange, t: TFunction): string {
  switch (range) {
    case "24h":
      return t("monitor.audience.range.24h");
    case "7d":
      return t("monitor.audience.range.7d");
    case "30d":
      return t("monitor.audience.range.30d");
    default: {
      const unhandled: never = range;
      return unhandled;
    }
  }
}

function RangePills({
  value,
  onChange,
}: {
  value: AudienceRange;
  onChange: (range: AudienceRange) => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
      {AUDIENCE_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          onClick={() => onChange(range)}
          className={cn(
            "rounded-lg px-3 py-1 text-xs font-medium transition-colors",
            value === range
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {rangeLabel(range, t)}
        </button>
      ))}
    </div>
  );
}

function SourceBadge({ source }: { source: AudienceSource }) {
  const t = useT();
  return (
    <Badge variant={source === "onedollar" ? "warning" : "neutral"}>
      {t("monitor.audience.source", { source: sourceLabel(source, t) })}
    </Badge>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Percent change from the previous window; null when there is nothing to compare. */
function change(current: number, previous: number | null | undefined) {
  if (previous === null || previous === undefined || previous === 0) {
    return null;
  }
  return ((current - previous) / previous) * 100;
}

function Delta({ pct, goodDown = false }: { pct: number; goodDown?: boolean }) {
  const t = useT();
  const good = goodDown ? pct <= 0 : pct >= 0;
  return (
    <span
      className={cn("text-meta", good ? "text-success" : "text-destructive")}
    >
      {t("monitor.audience.vsPrevious", {
        change: `${pct >= 0 ? "+" : ""}${Math.round(pct)}%`,
      })}
    </span>
  );
}

function SummaryCards({
  summary,
  previous,
}: {
  summary: AudienceSummary;
  previous: AudienceSummary | null;
}) {
  const t = useT();
  const cards: {
    key: string;
    title: string;
    value: string;
    pct: number | null;
    goodDown?: boolean;
  }[] = [
    {
      key: "visitors",
      title: t("monitor.audience.visitors"),
      value: formatNumber(summary.visitors),
      pct: change(summary.visitors, previous?.visitors),
    },
    {
      key: "pageviews",
      title: t("monitor.audience.pageviews"),
      value: formatNumber(summary.pageviews),
      pct: change(summary.pageviews, previous?.pageviews),
    },
  ];
  if (summary.sessions !== null) {
    cards.push({
      key: "sessions",
      title: t("monitor.audience.sessions"),
      value: formatNumber(summary.sessions),
      pct: change(summary.sessions, previous?.sessions),
    });
  }
  if (summary.bounceRate !== null) {
    cards.push({
      key: "bounce",
      title: t("monitor.audience.bounceRate"),
      value: `${Math.round(summary.bounceRate)}%`,
      pct: change(summary.bounceRate, previous?.bounceRate),
      goodDown: true,
    });
  }
  if (summary.visitDurationS !== null) {
    cards.push({
      key: "duration",
      title: t("monitor.audience.visitDuration"),
      value: formatDuration(summary.visitDurationS),
      pct: change(summary.visitDurationS, previous?.visitDurationS),
    });
  }
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
      {cards.map((card) => (
        <MetricCard
          key={card.key}
          title={card.title}
          value={card.value}
          caption={
            card.pct !== null && (
              <Delta pct={card.pct} goodDown={card.goodDown} />
            )
          }
        />
      ))}
    </div>
  );
}

function VisitorsChart({
  points,
}: {
  points: { t: string; visitors: number; pageviews: number }[];
}) {
  const t = useT();
  return (
    <section className="surface flex flex-col gap-4 p-4">
      <h3 className="text-sm text-foreground/70">
        {t("monitor.audience.overTime")}
      </h3>
      <ChartContainer
        config={{
          visitors: {
            label: t("monitor.audience.visitors"),
            color: COLOR_VISITORS,
          },
        }}
        className="h-64 w-full"
      >
        <AreaChart
          data={points}
          margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="t"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={32}
            tickFormatter={(v: string) => String(v).slice(5, 16)}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={48}
            tickFormatter={(v: number) => formatNumber(v)}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Area
            dataKey="visitors"
            type="monotone"
            fill={COLOR_VISITORS}
            fillOpacity={0.15}
            stroke={COLOR_VISITORS}
            strokeWidth={2}
          />
        </AreaChart>
      </ChartContainer>
    </section>
  );
}

function Ranked({ title, rows }: { title: string; rows: AudienceRow[] }) {
  const t = useT();
  const top = rows.slice(0, 8);
  const max = Math.max(1, ...top.map((r) => r.count));
  return (
    <section className="surface flex flex-col gap-3 p-4">
      <h3 className="text-sm text-foreground/70">{title}</h3>
      {top.length === 0 ? (
        <p className="text-meta">{t("monitor.audience.noRows")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {top.map((row) => (
            <li key={row.key} className="relative flex items-center gap-2">
              <span
                className="absolute inset-y-0 left-0 rounded-md bg-muted"
                style={{ width: `${(row.count / max) * 100}%` }}
              />
              <span className="relative min-w-0 flex-1 truncate px-2 py-1 text-sm">
                {row.key}
              </span>
              <span className="tnum relative px-2 text-sm text-muted-foreground">
                {formatNumber(row.count)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RankedPanel({
  orgSlug,
  project,
  view,
  range,
  title,
}: {
  orgSlug: string;
  project: SiteProject;
  view: "pages" | "sources" | "countries" | "devices";
  range: AudienceRange;
  title: string;
}) {
  const query = useAudience(orgSlug, project, view, range);
  if (query.isLoading) return <Skeleton className="h-64" />;
  const body = query.data;
  const rows =
    body?.available && "rows" in body.data ? body.data.rows : ([] as const);
  return <Ranked title={title} rows={[...rows]} />;
}

function NoSource({ project }: { project: SiteProject }) {
  const t = useT();
  const { org } = useProjectContext();
  return (
    <EmptyState
      icon={<BarChart10 size={20} />}
      title={t("monitor.audience.empty.title")}
      description={t("monitor.audience.empty.desc")}
      buttonComponent={
        <Button asChild size="sm">
          <Link {...projectLink(org.slug, project.id, "analytics")}>
            {t("monitor.audience.empty.cta")}
          </Link>
        </Button>
      }
    />
  );
}

/** One project's audience. */
export function ProjectAudience({ project }: { project: SiteProject }) {
  const t = useT();
  const { org } = useProjectContext();
  const [range, setRange] = useState<AudienceRange>("7d");
  const summary = useAudience(org.slug, project, "summary", range);
  const timeline = useAudience(org.slug, project, "timeline", range);

  const frame = (body: ReactNode, header?: ReactNode) => (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 pt-6 pb-10 md:px-10">
        {header}
        {body}
      </div>
    </div>
  );

  if (summary.isLoading) {
    return frame(
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>,
    );
  }
  if (summary.error) {
    return frame(
      <EmptyState
        icon={<BarChart10 size={20} />}
        title={t("monitor.audience.error")}
        description={summary.error.message}
      />,
    );
  }
  const body = summary.data;
  if (!body?.available) return frame(<NoSource project={project} />);

  const points =
    timeline.data?.available && timeline.data.data.view === "timeline"
      ? timeline.data.data.points
      : [];
  const window =
    body.window.kind === "calendar" && body.range === "24h"
      ? t("monitor.audience.todayUtc")
      : null;

  return frame(
    <>
      {body.data.view === "summary" && (
        <SummaryCards
          summary={body.data.summary}
          previous={body.data.previous}
        />
      )}
      {timeline.isLoading ? (
        <Skeleton className="h-72" />
      ) : (
        points.length > 1 && <VisitorsChart points={points} />
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <RankedPanel
          orgSlug={org.slug}
          project={project}
          view="pages"
          range={range}
          title={t("monitor.audience.pages")}
        />
        <RankedPanel
          orgSlug={org.slug}
          project={project}
          view="sources"
          range={range}
          title={t("monitor.audience.sources")}
        />
        <RankedPanel
          orgSlug={org.slug}
          project={project}
          view="countries"
          range={range}
          title={t("monitor.audience.countries")}
        />
        <RankedPanel
          orgSlug={org.slug}
          project={project}
          view="devices"
          range={range}
          title={t("monitor.audience.devices")}
        />
      </div>
    </>,
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <SourceBadge source={body.source} />
        {window && <span className="text-meta">{window}</span>}
      </div>
      <RangePills value={range} onChange={setRange} />
    </div>,
  );
}

/**
 * Every site project at once. Visitors from different sources don't add up,
 * so only pageviews are totalled; each site keeps its own row and source.
 */
export function OrgAudience({
  projects,
}: {
  projects: readonly SiteProject[];
}) {
  const t = useT();
  const { org } = useProjectContext();
  const [range, setRange] = useState<AudienceRange>("7d");
  const results = useQueries({
    queries: projects.map((p) => audienceQuery(org.slug, p, "summary", range)),
  });
  const rows = projects.map((project, i) => ({
    project,
    query: results[i],
  }));
  const withData = rows.flatMap(({ project, query }) =>
    query?.data?.available && query.data.data.view === "summary"
      ? [
          {
            project,
            source: query.data.source,
            summary: query.data.data.summary,
          },
        ]
      : [],
  );
  const loading = results.some((r) => r.isLoading);
  const pageviews = withData.reduce((sum, r) => sum + r.summary.pageviews, 0);
  const noSource = rows.filter(
    ({ query }) => query?.data && !query.data.available,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <RangePills value={range} onChange={setRange} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <MetricCard
          title={t("monitor.audience.org.pageviews")}
          value={
            loading && withData.length === 0 ? "…" : formatNumber(pageviews)
          }
          caption={
            <span className="text-meta">
              {t("monitor.audience.org.sites", {
                count: String(withData.length),
                total: String(projects.length),
              })}
            </span>
          }
        />
      </div>
      <section className="surface overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-meta border-b border-border text-left">
            <tr>
              <th className="px-4 py-2 font-normal">
                {t("monitor.audience.org.site")}
              </th>
              <th className="px-4 py-2 font-normal">
                {t("monitor.audience.org.source")}
              </th>
              <th className="px-4 py-2 text-right font-normal">
                {t("monitor.audience.visitors")}
              </th>
              <th className="px-4 py-2 text-right font-normal">
                {t("monitor.audience.pageviews")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ project, query }) => {
              const data = query?.data;
              return (
                <tr
                  key={project.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-2">
                    <Link
                      {...projectLink(org.slug, project.id, "monitoring")}
                      search={{ view: "audience" }}
                      className="hover:underline"
                    >
                      {project.title}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    {query?.isLoading ? (
                      <Skeleton className="h-5 w-24" />
                    ) : data?.available ? (
                      <SourceBadge source={data.source} />
                    ) : (
                      <span className="text-meta">
                        {data
                          ? t("monitor.audience.org.noSource")
                          : t("monitor.audience.org.failed")}
                      </span>
                    )}
                  </td>
                  <td className="tnum px-4 py-2 text-right">
                    {data?.available && data.data.view === "summary"
                      ? formatNumber(data.data.summary.visitors)
                      : "—"}
                  </td>
                  <td className="tnum px-4 py-2 text-right">
                    {data?.available && data.data.view === "summary"
                      ? formatNumber(data.data.summary.pageviews)
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      {noSource.length > 0 && (
        <p className="text-meta">{t("monitor.audience.org.noSourceHint")}</p>
      )}
    </div>
  );
}

/**
 * The Overview's line of audience for one site: today's visitors and
 * pageviews, opening the Audience tab. Nothing when the site has no source.
 */
export function AudienceGlance({
  project,
  onOpen,
}: {
  project: SiteProject;
  onOpen: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const query = useAudience(org.slug, project, "summary", "24h");
  const body = query.data;
  if (!body?.available || body.data.view !== "summary") return null;
  const { summary, previous } = body.data;
  const visitorsPct = change(summary.visitors, previous?.visitors);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <MetricCard
        title={t("monitor.audience.glance.visitors")}
        value={formatNumber(summary.visitors)}
        caption={visitorsPct !== null && <Delta pct={visitorsPct} />}
        aside={<SourceBadge source={body.source} />}
        onClick={onOpen}
      />
      <MetricCard
        title={t("monitor.audience.glance.pageviews")}
        value={formatNumber(summary.pageviews)}
        caption={
          <span className="text-meta">{t("monitor.audience.glance.open")}</span>
        }
        onClick={onOpen}
      />
    </div>
  );
}

/**
 * The Monitor's Audience tab: who visits the site, from whichever source the
 * site reports to (Deco Analytics, or OneDollarStats until it retires). One
 * shape for both — the server normalizes (`/api/:org/monitor/:site/audience`)
 * and says which source answered, which the tab names once, as a caption.
 */

import { type ReactNode, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BarChart10 } from "@untitledui/icons";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type {
  AudiencePoint,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Page } from "@/components/page";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import {
  fetchJson,
  formatCountry,
  formatNumber,
} from "@/layouts/main-panel-tabs/cdn-tab";
import { relativeChange } from "@/layouts/main-panel-tabs/monitor-v8";
import { AXIS_TICK, MetricCard } from "@/layouts/task-board/analytics-sections";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import type { SiteProject } from "./org-insights";
import { weightedMean } from "./aggregate";
import { projectLink, Spread, Trend } from "./parts";

const COLOR_VISITORS = "var(--chart-1)";

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

function useAudience(
  orgSlug: string,
  project: Pick<SiteProject, "site" | "analyticsSite">,
  view: AudienceView,
  range: AudienceRange,
) {
  return useQuery(audienceQuery(orgSlug, project, view, range));
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

function isRange(value: string): value is AudienceRange {
  return (AUDIENCE_RANGES as readonly string[]).includes(value);
}

/** The period, in the panel's top bar beside the Monitor's other controls. */
function RangeAction({
  value,
  onChange,
}: {
  value: AudienceRange;
  onChange: (range: AudienceRange) => void;
}) {
  const t = useT();
  return (
    <Page.Actions>
      <Select
        value={value}
        onValueChange={(next) => isRange(next) && onChange(next)}
      >
        <SelectTrigger size="sm" aria-label={t("monitor.audience.range")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {AUDIENCE_RANGES.map((range) => (
            <SelectItem key={range} value={range}>
              {rangeLabel(range, t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Page.Actions>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function delta(current: number, previous: number | null | undefined) {
  return previous ? relativeChange(current, previous) : null;
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
    change: number | null;
    better: "up" | "down";
  }[] = [
    {
      key: "visitors",
      title: t("monitor.audience.visitors"),
      value: formatNumber(summary.visitors),
      change: delta(summary.visitors, previous?.visitors),
      better: "up",
    },
    {
      key: "pageviews",
      title: t("monitor.audience.pageviews"),
      value: formatNumber(summary.pageviews),
      change: delta(summary.pageviews, previous?.pageviews),
      better: "up",
    },
  ];
  if (summary.bounceRate !== null) {
    cards.push({
      key: "bounce",
      title: t("monitor.audience.bounceRate"),
      value: `${Math.round(summary.bounceRate)}%`,
      change: delta(summary.bounceRate, previous?.bounceRate),
      better: "down",
    });
  }
  if (summary.visitDurationS !== null) {
    cards.push({
      key: "duration",
      title: t("monitor.audience.visitDuration"),
      value: formatDuration(summary.visitDurationS),
      change: delta(summary.visitDurationS, previous?.visitDurationS),
      better: "up",
    });
  }
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {cards.map((card) => (
        <MetricCard
          key={card.key}
          title={card.title}
          value={card.value}
          caption={
            <Trend change={card.change} better={card.better} reference="" />
          }
        />
      ))}
    </div>
  );
}

function VisitorsChart({
  points,
}: {
  points: { t: string; visitors: number }[];
}) {
  const t = useT();
  return (
    <MetricCard title={t("monitor.audience.overTime")}>
      <ChartContainer
        config={{
          visitors: {
            label: t("monitor.audience.visitors"),
            color: COLOR_VISITORS,
          },
        }}
        className="h-[170px] w-full"
      >
        <AreaChart data={points} margin={{ left: 0, right: 0, top: 4 }}>
          <CartesianGrid
            strokeDasharray="4 4"
            stroke="var(--border)"
            strokeOpacity={0.5}
            vertical={false}
          />
          <XAxis
            dataKey="t"
            axisLine={false}
            tickLine={false}
            tick={AXIS_TICK}
            tickMargin={8}
            minTickGap={32}
            tickFormatter={(v: string) =>
              v.length > 10 ? v.slice(11, 16) : v.slice(5)
            }
          />
          <YAxis
            orientation="right"
            axisLine={false}
            tickLine={false}
            tick={AXIS_TICK}
            width={44}
            tickCount={4}
            allowDecimals={false}
            tickFormatter={(v: number) => formatNumber(v)}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Area
            dataKey="visitors"
            type="monotone"
            fill={COLOR_VISITORS}
            fillOpacity={0.15}
            stroke={COLOR_VISITORS}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
        </AreaChart>
      </ChartContainer>
    </MetricCard>
  );
}

/** A titled list of rows, busiest first, each with a bar to its share of the top. */
export function Ranked({
  title,
  rows,
}: {
  title: string;
  rows: AudienceRow[];
}) {
  const t = useT();
  const top = rows.slice(0, 8);
  const max = Math.max(1, ...top.map((r) => r.count));
  return (
    <MetricCard title={title}>
      {top.length === 0 ? (
        <p className="text-meta">{t("monitor.audience.noRows")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {top.map((row) => (
            <li key={row.key} className="relative flex items-center">
              <span
                className="surface-inset absolute inset-y-0 left-0"
                style={{ width: `${(row.count / max) * 100}%` }}
              />
              <span className="relative min-w-0 flex-1 truncate px-2 py-1 text-sm text-foreground">
                {row.key}
              </span>
              <span className="tnum relative px-2 text-sm text-muted-foreground">
                {formatNumber(row.count)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </MetricCard>
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
    body?.available && "rows" in body.data
      ? body.data.rows.map((r) => ({ ...r, key: displayKey(view, r.key) }))
      : [];
  return <Ranked title={title} rows={rows} />;
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 pt-6 pb-10 md:px-10">
        {children}
      </div>
    </div>
  );
}

type Breakdown = "sources" | "countries" | "devices";

/** A breakdown key as a reader wants it: country codes as names, sources capitalized. */
function displayKey(view: AudienceView, key: string): string {
  if (view === "countries") return key.length === 2 ? formatCountry(key) : key;
  if (view === "sources" || view === "devices") {
    return key.charAt(0).toUpperCase() + key.slice(1);
  }
  return key;
}

/** One project's audience, in full. */
function ProjectAudience({
  project,
  range,
  onRange,
}: {
  project: SiteProject;
  range: AudienceRange;
  onRange: (range: AudienceRange) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const summary = useAudience(org.slug, project, "summary", range);
  const timeline = useAudience(org.slug, project, "timeline", range);
  const action = <RangeAction value={range} onChange={onRange} />;

  if (summary.isLoading) {
    return (
      <>
        {action}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </>
    );
  }
  if (summary.error) {
    return (
      <>
        {action}
        <EmptyState
          icon={<BarChart10 size={20} />}
          title={t("monitor.audience.error")}
          description={summary.error.message}
        />
      </>
    );
  }
  const body = summary.data;
  if (!body?.available) {
    return (
      <>
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
      </>
    );
  }

  const points =
    timeline.data?.available && timeline.data.data.view === "timeline"
      ? timeline.data.data.points
      : [];

  return (
    <>
      {action}
      {body.data.view === "summary" && (
        <div className="flex flex-col gap-2">
          <SummaryCards
            summary={body.data.summary}
            previous={body.data.previous}
          />
        </div>
      )}
      {timeline.isLoading ? (
        <Skeleton className="h-64" />
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
    </>
  );
}

const SITE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

/** One chart bucket key per range, whichever source labelled it. */
function bucketKey(t: string, range: AudienceRange): string {
  return range === "24h" ? t.slice(0, 13) : t.slice(0, 10);
}

/** Visitors over time, one stacked band per site: the total and who brought it. */
function StackedVisitors({
  sites,
  range,
}: {
  sites: { project: SiteProject; points: AudiencePoint[] }[];
  range: AudienceRange;
}) {
  const t = useT();
  const buckets = new Map<string, Record<string, number | string>>();
  for (const { project, points } of sites) {
    for (const p of points) {
      const key = bucketKey(p.t, range);
      const row = buckets.get(key) ?? { t: key };
      row[project.id] = (Number(row[project.id]) || 0) + p.visitors;
      buckets.set(key, row);
    }
  }
  // Sources cut their windows differently (a rolling 7 days against 7 whole
  // days), so only the buckets every site has stack without a gap.
  const shared = [...buckets.values()].filter((row) =>
    sites.every(({ project }) => project.id in row),
  );
  const data = (shared.length > 1 ? shared : [...buckets.values()]).sort(
    (a, b) => String(a.t).localeCompare(String(b.t)),
  );
  const color = (i: number) => SITE_COLORS[i % SITE_COLORS.length];
  return (
    <MetricCard title={t("monitor.audience.overTime")}>
      <div className="flex flex-col gap-3">
        <ul className="flex flex-wrap gap-x-5 gap-y-1">
          {sites.map(({ project }, i) => (
            <li key={project.id} className="flex items-center gap-2 text-sm">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: color(i) }}
              />
              {project.title}
            </li>
          ))}
        </ul>
        <ChartContainer
          config={Object.fromEntries(
            sites.map(({ project }, i) => [
              project.id,
              { label: project.title, color: color(i) },
            ]),
          )}
          className="h-[170px] w-full"
        >
          <AreaChart data={data} margin={{ left: 0, right: 0, top: 4 }}>
            <CartesianGrid
              strokeDasharray="4 4"
              stroke="var(--border)"
              strokeOpacity={0.5}
              vertical={false}
            />
            <XAxis
              dataKey="t"
              axisLine={false}
              tickLine={false}
              tick={AXIS_TICK}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={(v: string) =>
                v.length > 10 ? `${v.slice(11, 13)}:00` : v.slice(5)
              }
            />
            <YAxis
              orientation="right"
              axisLine={false}
              tickLine={false}
              tick={AXIS_TICK}
              width={44}
              tickCount={4}
              allowDecimals={false}
              tickFormatter={(v: number) => formatNumber(v)}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            {sites.map(({ project }, i) => (
              <Area
                key={project.id}
                dataKey={project.id}
                stackId="sites"
                type="monotone"
                fill={color(i)}
                fillOpacity={0.2}
                stroke={color(i)}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ChartContainer>
      </div>
    </MetricCard>
  );
}

/** One audience view for every site in the org. */
function useEverySite(
  orgSlug: string,
  projects: readonly SiteProject[],
  view: AudienceView,
  range: AudienceRange,
) {
  return useQueries({
    queries: projects.map((p) => audienceQuery(orgSlug, p, view, range)),
  });
}

const BREAKDOWN_TITLE = {
  sources: "monitor.audience.sources",
  countries: "monitor.audience.countries",
  devices: "monitor.audience.devices",
} as const;

/** Rows of one breakdown summed across sites under their display name. */
function sumRows(
  view: Breakdown,
  answers: (AudienceResponse | undefined)[],
): AudienceRow[] {
  const merged = new Map<string, number>();
  for (const a of answers) {
    if (!a?.available || !("rows" in a.data)) continue;
    for (const r of a.data.rows) {
      const key = displayKey(view, r.key);
      merged.set(key, (merged.get(key) ?? 0) + r.count);
    }
  }
  return [...merged]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Every site at once. What adds up across sites is summed (pageviews,
 * visitors, where they come from); what doesn't (bounce, visit length, top
 * pages) stays per site, in the table, one click from that site in full.
 */
function OrgAudience({
  projects,
  range,
  onRange,
  onProject,
}: {
  projects: readonly SiteProject[];
  range: AudienceRange;
  onRange: (range: AudienceRange) => void;
  onProject: (projectId: string) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const summaries = useEverySite(org.slug, projects, "summary", range);
  const timelines = useEverySite(org.slug, projects, "timeline", range);
  const breakdowns: Record<Breakdown, ReturnType<typeof useEverySite>> = {
    sources: useEverySite(org.slug, projects, "sources", range),
    countries: useEverySite(org.slug, projects, "countries", range),
    devices: useEverySite(org.slug, projects, "devices", range),
  };

  const rows = projects
    .map((project, i) => {
      const data = summaries[i]?.data;
      return {
        project,
        loading: summaries[i]?.isLoading ?? false,
        data,
        summary:
          data?.available && data.data.view === "summary" ? data.data : null,
      };
    })
    .sort(
      (a, b) =>
        (b.summary?.summary.visitors ?? -1) -
        (a.summary?.summary.visitors ?? -1),
    );
  const reporting = rows.filter((r) => r.summary);
  const total = (pick: (s: AudienceSummary) => number) =>
    reporting.reduce(
      (n, r) => n + (r.summary ? pick(r.summary.summary) : 0),
      0,
    );
  // A total compares only when every site reporting has a previous window.
  const previous = reporting.every((r) => r.summary?.previous)
    ? (pick: (s: AudienceSummary) => number) =>
        reporting.reduce(
          (n, r) => n + (r.summary?.previous ? pick(r.summary.previous) : 0),
          0,
        )
    : null;
  const loading = rows.some((r) => r.loading);
  // A rate over sessions averages across sites weighted by their sessions.
  const perSite = (pick: (s: AudienceSummary) => number | null) =>
    reporting.flatMap((r) => {
      const s = r.summary?.summary;
      const value = s ? pick(s) : null;
      return s && value !== null
        ? [
            {
              title: r.project.title,
              value,
              weight: s.sessions ?? s.visitors,
            },
          ]
        : [];
    });
  const bounce = perSite((s) => s.bounceRate);
  const visit = perSite((s) => s.visitDurationS);
  const sites = projects.flatMap((project, i) => {
    const d = timelines[i]?.data;
    return d?.available && d.data.view === "timeline"
      ? [{ project, points: d.data.points }]
      : [];
  });
  const action = <RangeAction value={range} onChange={onRange} />;

  if (!loading && reporting.length === 0) {
    return (
      <>
        {action}
        <EmptyState
          icon={<BarChart10 size={20} />}
          title={t("monitor.audience.empty.title")}
          description={t("monitor.audience.org.emptyDesc")}
        />
      </>
    );
  }

  const card = (title: string, pick: (s: AudienceSummary) => number) => (
    <MetricCard
      title={title}
      value={
        loading && reporting.length === 0 ? (
          <Skeleton className="h-9 w-24" />
        ) : (
          formatNumber(total(pick))
        )
      }
      caption={
        previous && (
          <Trend
            change={delta(total(pick), previous(pick))}
            better="up"
            reference=""
          />
        )
      }
    />
  );

  return (
    <>
      {action}
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {card(t("monitor.audience.visitors"), (s) => s.visitors)}
          {card(t("monitor.audience.pageviews"), (s) => s.pageviews)}
          {bounce.length > 0 && (
            <MetricCard
              title={t("monitor.audience.bounceRate")}
              value={`${Math.round(weightedMean(bounce) ?? 0)}%`}
              caption={
                <Spread
                  values={bounce}
                  format={(v) => `${Math.round(v)}%`}
                  lowerIsBetter
                />
              }
            />
          )}
          {visit.length > 0 && (
            <MetricCard
              title={t("monitor.audience.visitDuration")}
              value={formatDuration(weightedMean(visit) ?? 0)}
              caption={
                <Spread
                  values={visit}
                  format={formatDuration}
                  lowerIsBetter={false}
                />
              }
            />
          )}
        </div>
      </div>
      {sites.length > 0 && <StackedVisitors sites={sites} range={range} />}
      <div className="grid gap-4 md:grid-cols-3">
        {(["sources", "countries", "devices"] as const).map((view) =>
          breakdowns[view].some((q) => q.isLoading) ? (
            <Skeleton key={view} className="h-64" />
          ) : (
            <Ranked
              key={view}
              title={t(BREAKDOWN_TITLE[view])}
              rows={sumRows(
                view,
                breakdowns[view].map((q) => q.data),
              )}
            />
          ),
        )}
      </div>
      <section className="surface shrink-0 overflow-hidden">
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
                {t("monitor.audience.bounceRate")}
              </th>
              <th className="px-4 py-2 text-right font-normal">
                {t("monitor.audience.visitDuration")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ project, loading: rowLoading, data, summary }) => (
              <tr
                key={project.id}
                tabIndex={0}
                onClick={() => onProject(project.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onProject(project.id);
                  }
                }}
                className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/50"
              >
                <td className="px-4 py-2.5 text-foreground">{project.title}</td>
                <td className="px-4 py-2.5">
                  {rowLoading ? (
                    <Skeleton className="h-5 w-24" />
                  ) : data?.available ? (
                    <Badge variant="muted">{sourceLabel(data.source, t)}</Badge>
                  ) : (
                    <span className="text-meta">
                      {data
                        ? t("monitor.audience.org.noSource")
                        : t("monitor.audience.org.failed")}
                    </span>
                  )}
                </td>
                <td className="tnum px-4 py-2.5 text-right">
                  {summary ? (
                    <span className="inline-flex items-center gap-2">
                      {formatNumber(summary.summary.visitors)}
                      <Trend
                        change={delta(
                          summary.summary.visitors,
                          summary.previous?.visitors,
                        )}
                        better="up"
                        reference=""
                      />
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="tnum px-4 py-2.5 text-right">
                  {summary?.summary.bounceRate != null
                    ? `${Math.round(summary.summary.bounceRate)}%`
                    : "—"}
                </td>
                <td className="tnum px-4 py-2.5 text-right">
                  {summary?.summary.visitDurationS != null
                    ? formatDuration(summary.summary.visitDurationS)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

/** The Audience tab: one project in full, or every project at once. */
export function AudienceScreen({
  projects,
  scopeId,
  onProject,
}: {
  projects: readonly SiteProject[];
  scopeId: string | null;
  onProject: (projectId: string) => void;
}) {
  const t = useT();
  const [range, setRange] = useState<AudienceRange>("7d");
  const project = projects.find((p) => p.id === scopeId);
  if (scopeId && !project) {
    return (
      <Frame>
        <EmptyState
          icon={<BarChart10 size={20} />}
          title={t("mainPanelTabs.cdnTab.noSiteTitle")}
        />
      </Frame>
    );
  }
  return (
    <Frame>
      {project ? (
        <ProjectAudience
          key={project.id}
          project={project}
          range={range}
          onRange={setRange}
        />
      ) : (
        <OrgAudience
          projects={projects}
          range={range}
          onRange={setRange}
          onProject={onProject}
        />
      )}
    </Frame>
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
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <MetricCard
        title={t("monitor.audience.glance.visitors")}
        value={formatNumber(summary.visitors)}
        caption={
          <Trend
            change={delta(summary.visitors, previous?.visitors)}
            better="up"
            reference=""
          />
        }
        onClick={onOpen}
      />
      <MetricCard
        title={t("monitor.audience.glance.pageviews")}
        value={formatNumber(summary.pageviews)}
        caption={
          <Trend
            change={delta(summary.pageviews, previous?.pageviews)}
            better="up"
            reference=""
          />
        }
        onClick={onOpen}
      />
    </div>
  );
}

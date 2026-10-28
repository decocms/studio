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
import { fetchJson, formatNumber } from "@/layouts/main-panel-tabs/cdn-tab";
import { relativeChange } from "@/layouts/main-panel-tabs/monitor-v8";
import { AXIS_TICK, MetricCard } from "@/layouts/task-board/analytics-sections";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import type { SiteProject } from "./org-insights";
import { projectLink, Trend } from "./parts";

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
    body?.available && "rows" in body.data ? [...body.data.rows] : [];
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

/** One project's audience. */
export function ProjectAudience({ project }: { project: SiteProject }) {
  const t = useT();
  const { org } = useProjectContext();
  const [range, setRange] = useState<AudienceRange>("7d");
  const summary = useAudience(org.slug, project, "summary", range);
  const timeline = useAudience(org.slug, project, "timeline", range);
  const action = <RangeAction value={range} onChange={setRange} />;

  if (summary.isLoading) {
    return (
      <Frame>
        {action}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </Frame>
    );
  }
  if (summary.error) {
    return (
      <Frame>
        {action}
        <EmptyState
          icon={<BarChart10 size={20} />}
          title={t("monitor.audience.error")}
          description={summary.error.message}
        />
      </Frame>
    );
  }
  const body = summary.data;
  if (!body?.available) {
    return (
      <Frame>
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
      </Frame>
    );
  }

  const points =
    timeline.data?.available && timeline.data.data.view === "timeline"
      ? timeline.data.data.points
      : [];
  const caption = [
    t("monitor.audience.via", { source: sourceLabel(body.source, t) }),
    body.window.kind === "calendar" && body.range === "24h"
      ? t("monitor.audience.todayUtc")
      : null,
    body.data.view === "summary" && body.data.previous
      ? t("monitor.audience.vsPrevious")
      : null,
  ].filter(Boolean);

  return (
    <Frame>
      {action}
      {body.data.view === "summary" && (
        <div className="flex flex-col gap-2">
          <SummaryCards
            summary={body.data.summary}
            previous={body.data.previous}
          />
          <p className="text-meta">{caption.join(" · ")}</p>
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
    </Frame>
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
  const rows = projects
    .map((project, i) => {
      const data = results[i]?.data;
      return {
        project,
        loading: results[i]?.isLoading ?? false,
        data,
        summary:
          data?.available && data.data.view === "summary"
            ? data.data.summary
            : null,
      };
    })
    .sort(
      (a, b) => (b.summary?.pageviews ?? -1) - (a.summary?.pageviews ?? -1),
    );
  const reporting = rows.filter((r) => r.summary);
  const pageviews = reporting.reduce(
    (sum, r) => sum + (r.summary?.pageviews ?? 0),
    0,
  );
  const loading = rows.some((r) => r.loading);

  return (
    <div className="flex flex-col gap-4">
      <RangeAction value={range} onChange={setRange} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard
          title={t("monitor.audience.org.pageviews")}
          value={
            loading && reporting.length === 0 ? (
              <Skeleton className="h-9 w-24" />
            ) : (
              formatNumber(pageviews)
            )
          }
          caption={
            loading ? undefined : (
              <span className="text-meta">
                {t("monitor.audience.org.sites", {
                  count: String(reporting.length),
                  total: String(projects.length),
                })}
              </span>
            )
          }
        />
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
                {t("monitor.audience.pageviews")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ project, loading: rowLoading, data, summary }) => (
              <tr
                key={project.id}
                className="border-b border-border last:border-0"
              >
                <td className="px-4 py-2">
                  <Link
                    {...projectLink(org.slug, project.id, "monitoring")}
                    search={{ view: "audience" }}
                    className="text-foreground hover:underline"
                  >
                    {project.title}
                  </Link>
                </td>
                <td className="px-4 py-2">
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
                <td className="tnum px-4 py-2 text-right">
                  {summary ? formatNumber(summary.visitors) : "—"}
                </td>
                <td className="tnum px-4 py-2 text-right">
                  {summary ? formatNumber(summary.pageviews) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
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

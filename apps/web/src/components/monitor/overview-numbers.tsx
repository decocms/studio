/** The Overview's four most important numbers: each its figure, how it moved, and its shape. */

import type { ReactNode } from "react";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { changeTone, formatMs } from "@/layouts/main-panel-tabs/monitor-v8";
import { MetricCard } from "@/layouts/task-board/analytics-sections";
import { useProjectContext } from "@/sdk";
import { firstRow, fmtInt, n0, num, rowsOf } from "./analytics/panels";
import { EMPTY_SEGMENT, useDecoView } from "./analytics/segment";
import { useAudience } from "./audience-view";
import type { Kpi, KpiId, MetricPoint } from "./board";
import { useAnalyticsStatus } from "./deco-analytics";
import type { SiteProject } from "./org-insights";
import { Sparkline } from "./sparkline";

export interface OverviewNumber {
  key: string;
  label: string;
  /** What it counts and over which window, under the "?". */
  help: string;
  /** Null while it loads. */
  value: ReactNode | null;
  change?: ReactNode;
  chart: ReactNode;
}

/** How many cards the Overview shows, most important first. */
const CARDS = 4;
/** Fewer cards share the row instead of leaving it half empty. */
const WIDE = [
  "xl:grid-cols-1",
  "xl:grid-cols-2",
  "xl:grid-cols-3",
  "xl:grid-cols-4",
] as const;

function Help({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={text}
          className="focus-ring flex size-4 shrink-0 cursor-help items-center justify-center rounded-full bg-muted text-[0.625rem] font-medium text-muted-foreground"
        >
          ?
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{text}</TooltipContent>
    </Tooltip>
  );
}

/** The cards themselves, also drawn faded behind the connect card. */
export function NumberCards({ numbers }: { numbers: OverviewNumber[] }) {
  if (numbers.length === 0) return null;
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4",
        numbers.length > 1 && "sm:grid-cols-2",
        WIDE[Math.min(numbers.length, CARDS) - 1],
      )}
    >
      {numbers.map((n) => (
        <MetricCard
          key={n.key}
          title={n.label}
          value={n.value ?? undefined}
          caption={
            n.value === null ? (
              <Skeleton className="h-9 w-3/5 rounded-lg" />
            ) : (
              n.change
            )
          }
          aside={<Help text={n.help} />}
        >
          <div className="mt-auto h-16">
            {n.value === null ? <Skeleton className="h-full" /> : n.chart}
          </div>
        </MetricCard>
      ))}
    </div>
  );
}

/** How a figure moved against a window like it, coloured by whether that is good. */
function Change({
  current,
  previous,
  against,
  better = "up",
}: {
  current: number;
  previous: number;
  against: string;
  better?: "up" | "down";
}) {
  const diff = (100 * (current - previous)) / previous;
  const rounded = Math.round(diff);
  const tone = changeTone(diff / 100, better);
  return (
    <span className="text-meta tnum inline-flex items-center gap-1">
      <span
        className={cn(
          "font-medium",
          tone === "good" && "text-success",
          tone === "bad" && "text-destructive",
        )}
      >
        {rounded === 0
          ? "0%"
          : `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)}%`}
      </span>
      {against}
    </span>
  );
}

/** Five-minute buckets as hours: counts add up, rates average. */
function hourly(
  points: readonly MetricPoint[] | null,
  key: "value" | "w1",
  rate: boolean,
): (number | null)[] {
  const hours = new Map<number, number[]>();
  for (const p of points ?? []) {
    const v = p[key];
    if (v === null) continue;
    const h = Math.floor(p.bucket / 12);
    hours.set(h, [...(hours.get(h) ?? []), v]);
  }
  const last = Math.max(-1, ...hours.keys());
  return Array.from({ length: last + 1 }, (_, h) => {
    const vs = hours.get(h);
    if (!vs) return null;
    const sum = vs.reduce((a, b) => a + b, 0);
    return rate ? sum / vs.length : sum;
  });
}

/** Today so far and last week up to the same moment, from the buckets both have. */
function soFar(points: readonly MetricPoint[] | null) {
  const both = (points ?? []).filter((p) => p.value !== null && p.w1 !== null);
  if (both.length === 0) return null;
  const add = (k: "value" | "w1") => both.reduce((a, p) => a + (p[k] ?? 0), 0);
  return { current: add("value"), previous: add("w1") };
}

/** The overview view of Deco Analytics, read only on today's board. */
function useDecoOverview(project: SiteProject | undefined, today: boolean) {
  const { org } = useProjectContext();
  const status = useAnalyticsStatus(
    org.slug,
    { site: project?.site ?? "" },
    project !== undefined,
  );
  const registered =
    project !== undefined && status.data?.registered === true && today;
  const query = useDecoView({
    orgSlug: org.slug,
    site: project?.site ?? "",
    view: "overview",
    range: "24h",
    segment: EMPTY_SEGMENT,
    enabled: registered,
  });
  return {
    loading: status.isLoading || (registered && query.isLoading),
    data: registered ? query.data?.data : undefined,
  };
}

export function OverviewNumbers({
  project,
  today,
  kpis: board,
}: {
  /** The site the Overview is on; none across the org. */
  project: SiteProject | undefined;
  today: boolean;
  /** The board's own figures for the day: orders, cancellations, errors… */
  kpis: readonly Kpi[];
}) {
  const t = useT();
  const { org } = useProjectContext();
  const deco = useDecoOverview(project, today);
  const site = project ?? { site: "", analyticsSite: "" };
  const reading = project !== undefined && today && !deco.data;
  const summary = useAudience(org.slug, site, "summary", "24h", reading);
  const timeline = useAudience(org.slug, site, "timeline", "24h", reading);

  // Traffic: Deco Analytics' rolling 24 h, else the other source's today.
  const kpis = firstRow(deco.data, "kpis");
  const prev = firstRow(deco.data, "kpisPrev");
  const series = rowsOf(deco.data, "series");
  const other =
    summary.data?.available && summary.data.data.view === "summary"
      ? summary.data
      : null;
  const otherSummary = other?.data.view === "summary" ? other.data : null;
  const calendar = other?.window.kind === "calendar";
  const points =
    timeline.data?.available && timeline.data.data.view === "timeline"
      ? timeline.data.data.points
      : [];
  const trafficLoading =
    deco.loading || (reading && (summary.isLoading || timeline.isLoading));

  const pending = (key: string, label: string, help: string) => ({
    key,
    label,
    help,
    value: null,
    chart: null,
  });

  const trafficCard = (
    metric: "visitors" | "pageviews",
    label: string,
    help: string,
  ): OverviewNumber | false => {
    if (trafficLoading) return pending(metric, label, help);
    // Across the org, or on a past day, the board's own visitors stand in.
    if (!kpis && !otherSummary) {
      return (
        metric === "visitors" &&
        boardCard(
          "audience",
          label,
          t("monitor.overview.visitorsHelpToday"),
          fmtInt,
          { whole: true },
        )
      );
    }
    const current = kpis
      ? num(kpis[metric])
      : (otherSummary?.summary[metric] ?? null);
    const previous = kpis
      ? num(prev?.[metric])
      : (otherSummary?.previous?.[metric] ?? null);
    const values = kpis
      ? series.map((r) => n0(r[metric]))
      : points.map((p) => p[metric]);
    // Today so far against a whole yesterday, or a half-collected window, is not a comparison.
    const comparable =
      previous !== null &&
      previous > 0 &&
      !calendar &&
      (num(prev?.covered) ?? 1) >= 0.9;
    return (
      current !== null &&
      values.length > 1 && {
        key: metric,
        label,
        help,
        value: fmtInt(current),
        change: comparable && previous !== null && (
          <Change
            current={current}
            previous={previous}
            against={t("monitor.overview.vsPrior")}
          />
        ),
        chart: <Sparkline values={values} className="h-16" />,
      }
    );
  };

  const boardCard = (
    id: KpiId,
    label: string,
    help: string,
    format: (n: number) => string,
    {
      rate = false,
      better = "up",
      whole = rate,
    }: {
      rate?: boolean;
      better?: "up" | "down";
      /** The figure and last week's already cover the same span: a rate's hours don't average into its day. */
      whole?: boolean;
    } = {},
  ): OverviewNumber | false => {
    const k = board.find((x) => x.id === id);
    const v = k ? (k.soFar ?? k.value) : null;
    if (!k || v === null) return false;
    const compared = whole
      ? k.references.w1 === null
        ? null
        : { current: v, previous: k.references.w1 }
      : soFar(k.points);
    return {
      key: id,
      label,
      help,
      value: format(v),
      change: compared && compared.previous > 0 && (
        <Change
          current={compared.current}
          previous={compared.previous}
          against={t("monitor.overview.vsLastWeek")}
          better={better}
        />
      ),
      chart: (
        <Sparkline
          values={hourly(k.points, "value", rate)}
          reference={hourly(k.points, "w1", rate)}
          className="h-16"
        />
      ),
    };
  };

  // Only numbers with a figure, a change and a shape are drawn here.
  const candidates: (OverviewNumber | false)[] = [
    boardCard(
      "orders",
      t("monitor.overview.orders"),
      t("monitor.overview.ordersHelpStore"),
      fmtInt,
    ),
    trafficCard(
      "visitors",
      t("monitor.overview.visitors"),
      calendar
        ? t("monitor.overview.visitorsHelpToday")
        : t("monitor.overview.visitorsHelp"),
    ),
    trafficCard(
      "pageviews",
      t("monitor.overview.pageviews"),
      calendar
        ? t("monitor.overview.pageviewsHelpToday")
        : t("monitor.overview.pageviewsHelp"),
    ),
    boardCard(
      "cancellations",
      t("monitor.overview.cancellations"),
      t("monitor.overview.cancellationsHelp"),
      fmtInt,
      { better: "down" },
    ),
    boardCard(
      "conversion",
      t("monitor.overview.conversion"),
      t("monitor.overview.conversionHelp"),
      (v) => `${(v * 100).toFixed(2)}%`,
      { rate: true },
    ),
    boardCard(
      "errors",
      t("monitor.overview.errors"),
      t("monitor.overview.errorsHelp"),
      fmtInt,
      { better: "down" },
    ),
    boardCard(
      "latency",
      t("monitor.overview.latency"),
      t("monitor.overview.latencyHelp"),
      (v) => formatMs(v),
      { rate: true, better: "down" },
    ),
  ];
  const numbers = candidates
    .filter((n): n is OverviewNumber => n !== false)
    .slice(0, CARDS);
  return <NumberCards numbers={numbers} />;
}

/**
 * One Overview number opened up: its day per hour with axes, each reference
 * day (D-1, W-1, Y-1) with its total and how today compares, the order
 * monitor's warning-to-alert band, the projection to midnight, a target when
 * the metric has one, and the day's deploys and rollouts.
 *
 *   - orders are a line that runs on dashed to midnight as the projection;
 *   - sparse counts (cancellations, errors) are bars, each with the reference
 *     hour as a tick across it, and a spike turns red;
 *   - a rate (conversion) sits inside a grey band of what is normal for the
 *     hour;
 *   - a latency sits under its target, the area above it tinted.
 *
 * Deploys are hairlines under a marker above the plot, tinted by what they
 * did; pointing at one lights its line and shades the hour its verdict is
 * measured on.
 */

import { type ReactNode, useState } from "react";
import { Flag01, GitCommit, XClose } from "@untitledui/icons";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  Scatter,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@decocms/ui/components/button.tsx";
import { ChartContainer, ChartTooltip } from "@decocms/ui/components/chart.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import {
  formatCount,
  formatMs,
  relativeChange,
} from "@/layouts/main-panel-tabs/monitor-v8";
import { AXIS_TICK, MetricCard } from "@/layouts/task-board/analytics-sections";
import type {
  ChangeKind,
  Comparison,
  Deploy,
  DeployVerdict,
  ImpactMetric,
  Kpi,
  KpiId,
  MetricPoint,
} from "./board";
import { fmtInt } from "./analytics/panels";
import { Trend, verdictName } from "./parts";

const COLOR_TODAY = "var(--chart-1)";
const COLOR_REFERENCE = "var(--muted-foreground)";
const Y_AXIS_WIDTH = 44;
const COMPARISONS: readonly Comparison[] = ["d1", "w1", "y1"];
const BUCKETS_PER_HOUR = 12;
/** No 00:00 at the left edge, where its label would be cut. */
const HOUR_TICKS = [3, 6, 9, 12, 15, 18, 21, 24];
/** How far a rate may sit from the reference hour and still be normal. */
const NORMAL_WIDTH = 0.1;

type Shape = "lines" | "bars" | "area" | "band" | "threshold";

const SHAPE: Record<KpiId, Shape> = {
  orders: "lines",
  errors: "bars",
  cancellations: "bars",
  audience: "area",
  pageviews: "area",
  conversion: "band",
  latency: "threshold",
};

/** Rates and latencies average over the hour; counts add up. */
const isRate = (shape: Shape) => shape === "band" || shape === "threshold";

const BETTER: Record<KpiId, "up" | "down"> = {
  orders: "up",
  conversion: "up",
  audience: "up",
  pageviews: "up",
  latency: "down",
  errors: "down",
  cancellations: "down",
};

/** How each reference day is drawn, on the chart and on its toggle alike. */
const REFERENCE_STROKE: Record<
  Comparison,
  { dash: string | undefined; opacity: number }
> = {
  d1: { dash: "4 3", opacity: 0.7 },
  w1: { dash: undefined, opacity: 0.55 },
  y1: { dash: "1 3", opacity: 0.9 },
};

function Swatch({
  color,
  dash,
  opacity = 1,
}: {
  color: string;
  dash?: string;
  opacity?: number;
}) {
  return (
    <svg
      width="14"
      height="6"
      viewBox="0 0 14 6"
      aria-hidden
      className="size-auto shrink-0"
    >
      <line
        x1="0"
        x2="14"
        y1="3"
        y2="3"
        stroke={color}
        strokeOpacity={opacity}
        strokeWidth={2}
        strokeDasharray={dash}
        strokeLinecap="round"
      />
    </svg>
  );
}

const ReferenceSwatch = ({ comparison }: { comparison: Comparison }) => (
  <Swatch
    color={COLOR_REFERENCE}
    dash={REFERENCE_STROKE[comparison].dash}
    opacity={REFERENCE_STROKE[comparison].opacity}
  />
);

const ProjectionSwatch = () => <Swatch color={COLOR_TODAY} dash="3 2" />;

function comparisonLabel(c: Comparison, t: TFunction): string {
  switch (c) {
    case "d1":
      return t("monitor.compare.d1");
    case "w1":
      return t("monitor.compare.w1");
    case "y1":
      return t("monitor.compare.y1");
    default: {
      const unhandled: never = c;
      return unhandled;
    }
  }
}

const COMPARISON_SHORT: Record<Comparison, string> = {
  d1: "D-1",
  w1: "W-1",
  y1: "Y-1",
};

function impactLabel(metric: ImpactMetric, t: TFunction): string {
  switch (metric) {
    case "orders":
      return t("monitor.metric.orders");
    case "errors":
      return t("monitor.metric.errors");
    case "latency":
      return t("monitor.metric.latency");
    default: {
      const unhandled: never = metric;
      return unhandled;
    }
  }
}

/** The headline figure: a day's total, or a rate (a share) or a latency. */
function formatValue(id: KpiId, value: number): string {
  if (id === "conversion") return `${(value * 100).toFixed(2)}%`;
  if (id === "latency") return formatMs(value);
  return fmtInt(value);
}

/** A plotted value: a rate's points are already percentages. */
function formatPoint(id: KpiId, value: number): string {
  if (id === "conversion") return `${value.toFixed(2)}%`;
  return formatValue(id, value);
}

function formatTick(id: KpiId, value: number): string {
  return id === "conversion"
    ? `${Number(value.toFixed(2))}%`
    : formatCount(value);
}

/** Round axis ends and steps (1, 2, 2.5, 5 × 10ⁿ), so ticks read at a glance. */
function niceScale(lo: number, hi: number, count = 4) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) {
    ticks.push(Number(v.toFixed(6)));
  }
  return { domain: [min, max] as [number, number], ticks };
}

const hourLabel = (hour: number) => {
  const minutes = Math.round(hour * 60);
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};

interface PlotPoint {
  /** The middle of the hour, so a bar or point sits inside its hour. */
  x: number;
  hour: number;
  value: number | null;
  /** Where the day is heading, past now; also on the last hour so it joins. */
  projected: number | null;
  refs: Record<Comparison, number | null>;
  /** The order monitor's warning-to-alert range, or a rate's normal range. */
  band: [number, number] | null;
}

/** The points by hour of the local day: counts add up, rates average. */
export function byHour(
  points: readonly MetricPoint[],
  rate: boolean,
): Omit<PlotPoint, "projected">[] {
  const hours = new Map<number, MetricPoint[]>();
  for (const p of points) {
    const h = Math.floor(p.bucket / BUCKETS_PER_HOUR);
    hours.set(h, [...(hours.get(h) ?? []), p]);
  }
  return [...hours.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hour, group]) => {
      const fold = (pick: (p: MetricPoint) => number | null | undefined) => {
        const vs = group.flatMap((p) => {
          const v = pick(p);
          return v === null || v === undefined ? [] : [v];
        });
        if (vs.length === 0) return null;
        const total = vs.reduce((a, b) => a + b, 0);
        return rate ? total / vs.length : total;
      };
      const lo = fold((p) => p.band && Math.min(...p.band));
      const hi = fold((p) => p.band && Math.max(...p.band));
      return {
        x: hour + 0.5,
        hour,
        value: fold((p) => p.value),
        refs: {
          d1: fold((p) => p.d1),
          w1: fold((p) => p.w1),
          y1: fold((p) => p.y1),
        },
        band: lo !== null && hi !== null ? [lo, hi] : null,
      };
    });
}

/** Where a change falls on the day's axis, in hours since local midnight. */
const changeHour = (change: Deploy, dayStart: number) =>
  Math.max(0, (Date.parse(change.at) - dayStart) / 3_600_000);

/**
 * The reference hour as a tick across its bar, like a bullet chart. A fixed
 * function: recharts re-renders without end when handed a new one each time.
 */
function ReferenceTick(props: { cx?: number; cy?: number }) {
  if (props.cx === undefined || props.cy === undefined) return <g />;
  return (
    <line
      x1={props.cx - 10}
      x2={props.cx + 10}
      y1={props.cy}
      y2={props.cy}
      stroke="var(--foreground)"
      strokeOpacity={0.55}
      strokeWidth={2}
      strokeLinecap="round"
    />
  );
}

const VERDICT_RANK: Record<DeployVerdict, number> = {
  regression: 3,
  improvement: 2,
  settling: 1,
  neutral: 0,
  unmeasured: 0,
};

const VERDICT_TINT: Record<DeployVerdict, string> = {
  regression: "var(--destructive)",
  improvement: "var(--success)",
  settling: "var(--muted-foreground)",
  neutral: "var(--muted-foreground)",
  unmeasured: "var(--muted-foreground)",
};

const VERDICT_BADGE: Record<DeployVerdict, string> = {
  regression: "bg-destructive/10 text-destructive",
  improvement: "bg-success/10 text-success",
  settling: "bg-muted text-muted-foreground",
  neutral: "bg-muted text-muted-foreground",
  unmeasured: "bg-muted text-muted-foreground",
};

interface ChangeGroup {
  hour: number;
  changes: Deploy[];
}

/** Changes close enough that their markers would touch share one. */
function groupChanges(
  changes: readonly Deploy[],
  dayStart: number,
  end: number,
): ChangeGroup[] {
  const gap = end * 0.025;
  const groups: ChangeGroup[] = [];
  const sorted = [...changes].sort(
    (a, b) => changeHour(a, dayStart) - changeHour(b, dayStart),
  );
  for (const change of sorted) {
    const hour = changeHour(change, dayStart);
    const last = groups.at(-1);
    const lastChange = last?.changes.at(-1);
    if (last && lastChange && hour - changeHour(lastChange, dayStart) <= gap) {
      last.changes.push(change);
    } else {
      groups.push({ hour, changes: [change] });
    }
  }
  return groups;
}

const worstVerdict = (changes: readonly Deploy[]): DeployVerdict =>
  changes.reduce<DeployVerdict>(
    (worst, c) =>
      VERDICT_RANK[c.verdict] > VERDICT_RANK[worst] ? c.verdict : worst,
    "neutral",
  );

function KindIcon({ kind, size }: { kind: ChangeKind; size: number }) {
  return kind === "rollout" ? (
    <Flag01 size={size} />
  ) : (
    <GitCommit size={size} />
  );
}

function ChangeCard({ change, time }: { change: Deploy; time: string }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-meta flex items-center gap-1.5">
        <KindIcon kind={change.kind} size={12} />
        <span>
          {change.kind === "rollout"
            ? t("monitor.chart.rollout")
            : t("monitor.chart.deploy")}{" "}
          · {time}
        </span>
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 py-px text-[11px] font-medium",
            VERDICT_BADGE[change.verdict],
          )}
        >
          {verdictName(change.verdict, t)}
        </span>
      </div>
      <p className="text-sm leading-snug font-medium text-foreground">
        {change.message}
      </p>
      <p className="text-meta">
        {change.author} · {change.projectTitle}
      </p>
      {change.impact.length > 0 && (
        <div className="mt-1 flex flex-col gap-1 border-t border-border/50 pt-2">
          <span className="text-meta">{t("monitor.chart.hourAfter")}</span>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {change.impact.map((i) => (
              <Trend
                key={i.metric}
                change={i.change}
                better={BETTER[i.metric]}
                reference={impactLabel(i.metric, t)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A marker's card, opened by pointing at the marker or focusing it. */
function ChangeMarker({
  trigger,
  onOpenChange,
  children,
}: {
  trigger: ReactNode;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const show = (next: boolean) => {
    setOpen(next);
    onOpenChange(next);
  };
  return (
    <Popover open={open} onOpenChange={show}>
      <PopoverTrigger
        asChild
        onMouseEnter={() => show(true)}
        onMouseLeave={() => show(false)}
        onFocus={() => show(true)}
        onBlur={() => show(false)}
      >
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="pointer-events-none w-80 p-3"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The markers above the plot, aligned with its x axis: a commit for a deploy,
 * a flag for a rollout, tinted by the verdict; a count where several meet.
 */
function ChangeLane({
  changes,
  dayStart,
  end,
  focused,
  onFocus,
}: {
  changes: readonly Deploy[];
  dayStart: number;
  end: number;
  focused: readonly string[];
  onFocus: (ids: readonly string[]) => void;
}) {
  const t = useT();
  return (
    <div className="relative h-5" style={{ marginRight: Y_AXIS_WIDTH }}>
      {groupChanges(changes, dayStart, end).map((group) => {
        const ids = group.changes.map((c) => c.id);
        const first = group.changes[0] as Deploy;
        const verdict = worstVerdict(group.changes);
        const rollout = group.changes.some((c) => c.kind === "rollout");
        const lit = ids.some((id) => focused.includes(id));
        return (
          <ChangeMarker
            key={first.id}
            onOpenChange={(open) => onFocus(open ? ids : [])}
            trigger={
              <button
                type="button"
                aria-label={
                  group.changes.length > 1
                    ? t("monitor.chart.changesAt", {
                        count: String(group.changes.length),
                        time: hourLabel(group.hour),
                      })
                    : first.message
                }
                className={cn(
                  "focus-ring absolute top-0 flex h-5 min-w-5 -translate-x-1/2 items-center justify-center gap-0.5 rounded-full border px-1 text-[10px] leading-none font-medium shadow-xs transition-transform",
                  verdict === "regression"
                    ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : verdict === "improvement"
                      ? "border-success/30 bg-success/10 text-success"
                      : rollout
                        ? "border-foreground bg-foreground text-background"
                        : "border-border bg-background text-muted-foreground",
                  lit && "z-10 scale-110",
                )}
                style={{
                  left: `${(Math.min(group.hour, end) / end) * 100}%`,
                }}
              >
                <KindIcon kind={rollout ? "rollout" : "deploy"} size={11} />
                {group.changes.length > 1 && (
                  <span className="tnum pr-0.5">{group.changes.length}</span>
                )}
              </button>
            }
          >
            <div className="flex flex-col divide-y divide-border/50">
              {group.changes.map((change) => (
                <div key={change.id} className="py-2 first:pt-0 last:pb-0">
                  <ChangeCard
                    change={change}
                    time={hourLabel(changeHour(change, dayStart))}
                  />
                </div>
              ))}
            </div>
          </ChangeMarker>
        );
      })}
    </div>
  );
}

function TooltipRow({
  mark,
  label,
  value,
}: {
  mark: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {mark}
      <span className="text-muted-foreground">{label}</span>
      <span className="tnum ml-auto pl-3 font-medium">{value}</span>
    </div>
  );
}

function PointTooltip({
  active,
  payload,
  kpi,
  shown,
  bandLabel,
  changes,
  dayStart,
}: {
  active?: boolean;
  payload?: { payload?: PlotPoint }[];
  kpi: Kpi;
  shown: readonly Comparison[];
  bandLabel: string;
  changes: readonly Deploy[];
  dayStart: number;
}) {
  const t = useT();
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const near = changes.filter(
    (c) => Math.floor(changeHour(c, dayStart)) === point.hour,
  );
  return (
    <div className="min-w-48 rounded-lg border bg-background px-3 py-2 shadow-md">
      <div className="mb-1 text-xs text-muted-foreground">
        {t("monitor.chart.range", {
          from: hourLabel(point.hour),
          to: hourLabel(point.hour + 1),
        })}
      </div>
      <div className="flex flex-col gap-1">
        {point.value !== null ? (
          <TooltipRow
            mark={
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: COLOR_TODAY }}
              />
            }
            label={t("monitor.chart.today")}
            value={formatPoint(kpi.id, point.value)}
          />
        ) : (
          point.projected !== null && (
            <TooltipRow
              mark={<ProjectionSwatch />}
              label={t("monitor.chart.projection")}
              value={formatPoint(kpi.id, point.projected)}
            />
          )
        )}
        {shown.map((c) => {
          const v = point.refs[c];
          return (
            v !== null && (
              <TooltipRow
                key={c}
                mark={<ReferenceSwatch comparison={c} />}
                label={comparisonLabel(c, t)}
                value={formatPoint(kpi.id, v)}
              />
            )
          );
        })}
        {point.band && (
          <TooltipRow
            mark={
              <span className="size-2 shrink-0 rounded-sm bg-muted-foreground/30" />
            }
            label={bandLabel}
            value={t("monitor.chart.range", {
              from: formatPoint(kpi.id, point.band[0]),
              to: formatPoint(kpi.id, point.band[1]),
            })}
          />
        )}
        {kpi.threshold !== undefined && (
          <TooltipRow
            mark={
              <span className="h-0 w-2 shrink-0 border-t border-dashed border-destructive" />
            }
            label={t("monitor.chart.target")}
            value={formatPoint(kpi.id, kpi.threshold)}
          />
        )}
      </div>
      {near.length > 0 && (
        <div className="mt-2 flex flex-col gap-1 border-t border-border/50 pt-2">
          {near.map((change) => (
            <div
              key={change.id}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span
                className="shrink-0"
                style={{ color: VERDICT_TINT[change.verdict] }}
              >
                <KindIcon kind={change.kind} size={12} />
              </span>
              <span className="tnum">
                {hourLabel(changeHour(change, dayStart))}
              </span>
              <span className="max-w-52 truncate text-foreground">
                {change.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Legend({
  kpi,
  shape,
  shown,
  projection,
  bandLabel,
  hasBand,
}: {
  kpi: Kpi;
  shape: Shape;
  shown: readonly Comparison[];
  projection: boolean;
  bandLabel: string;
  hasBand: boolean;
}) {
  const t = useT();
  return (
    <div className="text-meta flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="flex items-center gap-1.5">
        {shape === "bars" ? (
          <span className="size-2 rounded-sm bg-muted-foreground/70" />
        ) : (
          <span className="h-0.5 w-3 rounded-full bg-chart-1" />
        )}
        {t("monitor.chart.todayPerHour")}
      </span>
      {projection && (
        <span className="flex items-center gap-1.5">
          <ProjectionSwatch />
          {t("monitor.chart.projection")}
        </span>
      )}
      {shown.map((c) => (
        <span key={c} className="flex items-center gap-1.5">
          {shape === "bars" ? (
            <span className="h-0.5 w-3 rounded-full bg-foreground/55" />
          ) : (
            <ReferenceSwatch comparison={c} />
          )}
          {comparisonLabel(c, t)}
        </span>
      ))}
      {hasBand && (
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm bg-muted-foreground/20" />
          {bandLabel}
        </span>
      )}
      {shape === "bars" && (
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-destructive/70" />
          {t("monitor.chart.spike")}
        </span>
      )}
      {kpi.threshold !== undefined && (
        <span className="flex items-center gap-1.5">
          <span className="h-0 w-3 border-t border-dashed border-destructive" />
          {t("monitor.chart.target")}
        </span>
      )}
    </div>
  );
}

function Plot({
  kpi,
  title,
  points,
  shown,
  changes,
  dayStart,
}: {
  kpi: Kpi;
  title: string;
  points: MetricPoint[];
  shown: readonly Comparison[];
  changes: readonly Deploy[];
  dayStart: number;
}) {
  const t = useT();
  const [focused, setFocused] = useState<readonly string[]>([]);
  const shape = SHAPE[kpi.id];
  const rate = isRate(shape);
  const done = byHour(points, rate);
  const ahead = byHour(kpi.projection ?? [], rate);
  const lastHour = done.at(-1)?.hour ?? 0;
  // A projected day is drawn to midnight; otherwise today fills the plot.
  const end = ahead.length > 0 ? 24 : Math.min(24, lastHour + 2);
  const comparison = shown[0] ?? "w1";
  const data: PlotPoint[] = [
    ...done.map((p) => ({
      ...p,
      projected: ahead.length > 0 && p.hour === lastHour ? p.value : null,
    })),
    ...ahead.map((p) => ({ ...p, value: null, projected: p.value })),
  ].map((p) =>
    // A rate's normal range follows the reference hour.
    shape === "band" && p.band === null && p.refs[comparison] !== null
      ? {
          ...p,
          band: [
            (p.refs[comparison] as number) * (1 - NORMAL_WIDTH),
            (p.refs[comparison] as number) * (1 + NORMAL_WIDTH),
          ] as [number, number],
        }
      : p,
  );
  const hasBand = data.some((p) => p.band !== null);
  const bandLabel =
    shape === "band"
      ? t("monitor.chart.normal")
      : t("orderMonitor.thresholdBand");
  const values = data.flatMap((p) =>
    [
      p.value,
      p.projected,
      ...shown.map((c) => p.refs[c]),
      ...(p.band ?? []),
    ].filter((v): v is number => v !== null),
  );
  const lo = Math.min(...values, kpi.threshold ?? Number.POSITIVE_INFINITY);
  const hi = Math.max(...values, kpi.threshold ?? 0);
  // Counts start at zero; a level's axis hugs the data with room around it.
  const pad = (hi - lo) * 0.4;
  const scale = rate
    ? niceScale(Math.max(0, lo - pad), hi + pad)
    : niceScale(0, hi);
  // Only an hour well above the reference turns red, so the spike is what the eye finds.
  const barFill = (p: PlotPoint) => {
    const ref = p.refs[comparison] ?? 0;
    return (p.value ?? 0) > Math.max(ref * 1.8, ref + 3)
      ? "var(--destructive)"
      : "var(--muted-foreground)";
  };
  const gradient = `monitor-expanded-${kpi.id}`;
  return (
    <div className="flex flex-col gap-1">
      <ChangeLane
        changes={changes}
        dayStart={dayStart}
        end={end}
        focused={focused}
        onFocus={setFocused}
      />
      <ChartContainer
        role="img"
        aria-label={title}
        className="h-[240px] w-full md:h-[300px]"
        config={{
          value: { label: t("monitor.chart.today"), color: COLOR_TODAY },
        }}
      >
        <ComposedChart
          data={data}
          margin={{ left: 0, right: 0, top: 4 }}
          barCategoryGap={1}
        >
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLOR_TODAY} stopOpacity={0.18} />
              <stop offset="100%" stopColor={COLOR_TODAY} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="4 4"
            stroke="var(--border)"
            strokeOpacity={0.5}
            vertical={false}
          />
          <XAxis
            dataKey="x"
            type="number"
            domain={[0, end]}
            ticks={HOUR_TICKS.filter((tick) => tick <= end)}
            axisLine={false}
            tickLine={false}
            tick={AXIS_TICK}
            tickMargin={8}
            tickFormatter={hourLabel}
          />
          <YAxis
            orientation="right"
            axisLine={false}
            tickLine={false}
            tick={AXIS_TICK}
            width={Y_AXIS_WIDTH}
            domain={scale.domain}
            ticks={scale.ticks}
            tickFormatter={(v: number) => formatTick(kpi.id, v)}
          />
          <ChartTooltip
            cursor={
              shape === "bars"
                ? { fill: "var(--muted)", opacity: 0.5 }
                : { stroke: "var(--border)", strokeDasharray: "4 4" }
            }
            content={({ active, payload }) => (
              <PointTooltip
                active={active}
                payload={payload as { payload?: PlotPoint }[] | undefined}
                kpi={kpi}
                shown={shown}
                bandLabel={bandLabel}
                changes={changes}
                dayStart={dayStart}
              />
            )}
          />
          {kpi.threshold !== undefined && (
            <ReferenceArea
              y1={kpi.threshold}
              y2={scale.domain[1]}
              fill="var(--destructive)"
              fillOpacity={0.05}
              ifOverflow="hidden"
            />
          )}
          {kpi.threshold !== undefined && (
            <ReferenceLine
              y={kpi.threshold}
              stroke="var(--destructive)"
              strokeOpacity={0.6}
              strokeDasharray="4 4"
            />
          )}
          {changes
            .filter((change) => focused.includes(change.id))
            .map((change) => (
              <ReferenceArea
                key={`after-${change.id}`}
                x1={changeHour(change, dayStart)}
                x2={Math.min(end, changeHour(change, dayStart) + 1)}
                fill={VERDICT_TINT[change.verdict]}
                fillOpacity={0.07}
                ifOverflow="hidden"
              />
            ))}
          {changes.map((change) => {
            const lit = focused.includes(change.id);
            return (
              <ReferenceLine
                key={change.id}
                x={changeHour(change, dayStart)}
                stroke={
                  lit && change.verdict === "regression"
                    ? "var(--destructive)"
                    : "var(--foreground)"
                }
                strokeOpacity={
                  lit
                    ? 0.6
                    : focused.length > 0
                      ? 0.05
                      : change.kind === "rollout"
                        ? 0.28
                        : 0.12
                }
                strokeWidth={lit ? 1.25 : 1}
              />
            );
          })}
          {hasBand && (
            <Area
              type="monotone"
              dataKey="band"
              stroke="none"
              fill="var(--muted-foreground)"
              fillOpacity={0.12}
              activeDot={false}
              isAnimationActive={false}
            />
          )}
          {shape === "bars" && (
            <Bar
              dataKey="value"
              fillOpacity={0.55}
              radius={[3, 3, 0, 0]}
              barSize={14}
              isAnimationActive={false}
            >
              {data.map((p) => (
                <Cell key={p.hour} fill={barFill(p)} />
              ))}
            </Bar>
          )}
          {shape === "bars" && (
            <Scatter
              dataKey={`refs.${comparison}`}
              isAnimationActive={false}
              shape={ReferenceTick}
            />
          )}
          {shape !== "bars" &&
            shown.map((c) => (
              <Line
                key={c}
                type="monotone"
                dataKey={`refs.${c}`}
                stroke={COLOR_REFERENCE}
                strokeOpacity={REFERENCE_STROKE[c].opacity}
                strokeDasharray={REFERENCE_STROKE[c].dash}
                strokeWidth={1.5}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            ))}
          {ahead.length > 0 && (
            <Line
              type="monotone"
              dataKey="projected"
              stroke={COLOR_TODAY}
              strokeWidth={2}
              strokeOpacity={0.7}
              strokeDasharray="4 4"
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
          )}
          {(shape === "area" || shape === "lines") && (
            <Area
              type="monotone"
              dataKey="value"
              stroke={COLOR_TODAY}
              strokeWidth={2}
              fill={`url(#${gradient})`}
              dot={false}
              activeDot={{ r: 3, stroke: "var(--background)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          )}
          {rate && (
            <Line
              type="monotone"
              dataKey="value"
              stroke={COLOR_TODAY}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3, stroke: "var(--background)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ChartContainer>
      <Legend
        kpi={kpi}
        shape={shape}
        shown={shown}
        projection={ahead.length > 0}
        bandLabel={bandLabel}
        hasBand={hasBand}
      />
    </div>
  );
}

/**
 * The reference days, each with its figure and how today compares: any of
 * them drawn at once on a line chart, one at a time on bars and bands.
 */
function ReferencePicker({
  kpi,
  multiple,
  shown,
  onShown,
}: {
  kpi: Kpi;
  multiple: boolean;
  shown: readonly Comparison[];
  onShown: (shown: Comparison[]) => void;
}) {
  const t = useT();
  const current = kpi.value;
  const items = COMPARISONS.map((c) => {
    const ref = kpi.references[c];
    return (
      <ToggleGroupItem
        key={c}
        value={c}
        aria-label={comparisonLabel(c, t)}
        className="flex-none gap-1.5 px-2.5 text-xs font-normal"
      >
        {multiple && <ReferenceSwatch comparison={c} />}
        <span className="font-medium">{COMPARISON_SHORT[c]}</span>
        {current !== null && ref !== null && (
          <>
            <span className="tnum text-muted-foreground">
              {formatValue(kpi.id, ref)}
            </span>
            <Trend
              change={relativeChange(current, ref)}
              better={BETTER[kpi.id]}
              reference=""
            />
          </>
        )}
      </ToggleGroupItem>
    );
  });
  const pick = (values: string[]) =>
    onShown(COMPARISONS.filter((c) => values.includes(c)));
  return multiple ? (
    <ToggleGroup
      type="multiple"
      variant="outline"
      size="sm"
      aria-label={t("monitor.compare.label")}
      value={[...shown]}
      onValueChange={pick}
      className="flex-wrap justify-start"
    >
      {items}
    </ToggleGroup>
  ) : (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label={t("monitor.compare.label")}
      value={shown[0] ?? ""}
      // A single comparison is always on: clicking it again keeps it.
      onValueChange={(v) => v && pick([v])}
      className="flex-wrap justify-start"
    >
      {items}
    </ToggleGroup>
  );
}

/** An Overview card opened up, under the row of cards. */
export function ExpandedMetric({
  kpi,
  title,
  changes,
  dayStart,
  onClose,
}: {
  kpi: Kpi;
  title: string;
  /** The day's deploys and rollouts. */
  changes: readonly Deploy[];
  /** Local midnight of the day on screen, as an ISO instant. */
  dayStart: string;
  onClose: () => void;
}) {
  const t = useT();
  const shape = SHAPE[kpi.id];
  const [shown, setShown] = useState<Comparison[]>(["w1"]);
  return (
    <MetricCard
      title={title}
      value={
        kpi.value === null ? undefined : (
          <span className="flex items-baseline gap-2">
            {formatValue(kpi.id, kpi.value)}
            {kpi.projection && (
              <span className="text-meta font-sans tracking-normal">
                {t("monitor.chart.projectedLabel")}
              </span>
            )}
          </span>
        )
      }
      caption={
        kpi.soFar !== undefined && (
          <span className="text-meta">
            {t("monitor.chart.soFar", { count: fmtInt(kpi.soFar) })}
            {kpi.historyLoaded !== undefined &&
              ` · ${t("monitor.chart.historyLoading", {
                pct: `${Math.floor(kpi.historyLoaded * 100)}%`,
              })}`}
          </span>
        )
      }
      aside={
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("monitor.chart.close")}
          onClick={onClose}
        >
          <XClose size={16} />
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <ReferencePicker
          kpi={kpi}
          multiple={shape !== "bars" && shape !== "band"}
          shown={shown}
          onShown={setShown}
        />
        {kpi.points && (
          <Plot
            kpi={kpi}
            title={title}
            points={kpi.points}
            shown={shown}
            changes={changes}
            dayStart={Date.parse(dayStart)}
          />
        )}
      </div>
    </MetricCard>
  );
}

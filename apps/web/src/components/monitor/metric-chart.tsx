/**
 * One metric's day, drawn the way observability dashboards draw each kind of
 * signal (Grafana, Datadog, Vercel, Sentry):
 *
 *   - orders are a line per 15 minutes that runs on dashed to midnight as
 *     the day's projection, like the order monitor's, with each reference day
 *     the reader turns on (D-1, W-1, Y-1) as its own grey line over the whole
 *     day, styled like its toggle;
 *   - other counts (errors, cancellations) are few per 15 minutes, so they are
 *     bars per hour, each with the reference day's hour as a tick across it:
 *     a bar past its tick is the story, and a spike turns red;
 *   - volume (audience) is a smoothed area over yesterday;
 *   - a rate (conversion) is a smoothed line inside a grey band of what is
 *     normal for the time of day, so "is this odd?" is answered by whether
 *     the line leaves the band;
 *   - a latency is a smoothed line under its target, the area above the
 *     target tinted, like a Grafana threshold.
 *
 * Every chart on the page shares one crosshair (`syncId`), so hovering 13:15
 * on one shows 13:15 on all; only the chart under the pointer opens its
 * tooltip, the others just draw the line. Deploys and rollouts are hairlines through the
 * plot under a marker above it (a commit, or a flag for a rollout, tinted by
 * what it did); changes close together share one marker with a count. Pointing
 * at a marker lights its line on every chart and shades the hour after, the
 * hour its verdict is measured on. The page toggles them all at once.
 */

import { createContext, type ReactNode, useContext, useState } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { Flag01, GitCommit, Plus } from "@untitledui/icons";
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
import { IntegrationIcon } from "@/components/integration-icon";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import {
  formatCount,
  formatMs,
  relativeChange,
} from "@/layouts/main-panel-tabs/monitor-v8";
import { AXIS_TICK, MetricCard } from "@/layouts/task-board/analytics-sections";
import {
  BUCKET_MINUTES,
  BUCKETS_PER_DAY,
  COMPARISONS,
  type ChangeKind,
  type Comparison,
  type Deploy,
  type DeployVerdict,
  type Kpi,
  type KpiId,
  type MetricPoint,
} from "./board";
import { ConnectButton, FADED } from "./locked";
import { Trend, verdictName } from "./parts";
import { connectLabel } from "./sources-panel";

const COLOR_TODAY = "var(--chart-1)";
const COLOR_REFERENCE = "var(--muted-foreground)";
const Y_AXIS_WIDTH = 44;
export const SYNC_ID = "monitor-metrics";

/**
 * Whether the pointer is over this chart. The crosshair is shared across the
 * page, and recharts would open every synced chart's tooltip with it; only
 * the one being pointed at should.
 */
export function usePointer() {
  const [over, setOver] = useState(false);
  return {
    over,
    bind: {
      onMouseEnter: () => setOver(true),
      onMouseLeave: () => setOver(false),
    },
  };
}
export const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21].map(
  (h) => (h * 60) / BUCKET_MINUTES,
);

type Shape = "lines" | "bars" | "area" | "band" | "threshold";

const SHAPE: Record<KpiId, Shape> = {
  orders: "lines",
  errors: "bars",
  cancellations: "bars",
  audience: "area",
  conversion: "band",
  latency: "threshold",
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

/** A short sample of a reference day's line, for its toggle and tooltip. */
function ReferenceSwatch({ comparison }: { comparison: Comparison }) {
  const stroke = REFERENCE_STROKE[comparison];
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
        stroke={COLOR_REFERENCE}
        strokeOpacity={stroke.opacity}
        strokeWidth={1.5}
        strokeDasharray={stroke.dash}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The dashed purple of the day's projection. */
function ProjectionSwatch() {
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
        stroke={COLOR_TODAY}
        strokeWidth={2}
        strokeDasharray="3 2"
      />
    </svg>
  );
}

const BETTER: Record<KpiId, "up" | "down"> = {
  orders: "up",
  conversion: "up",
  audience: "up",
  latency: "down",
  errors: "down",
  cancellations: "down",
};

function kpiLabel(id: KpiId, t: TFunction): string {
  switch (id) {
    case "orders":
      return t("monitor.kpi.orders");
    case "conversion":
      return t("monitor.kpi.conversion");
    case "audience":
      return t("monitor.kpi.audience");
    case "latency":
      return t("monitor.kpi.latency");
    case "errors":
      return t("monitor.kpi.errors");
    case "cancellations":
      return t("monitor.kpi.cancellations");
    default: {
      const unhandled: never = id;
      return unhandled;
    }
  }
}

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

function comparisonShort(c: Comparison): string {
  switch (c) {
    case "d1":
      return "D-1";
    case "w1":
      return "W-1";
    case "y1":
      return "Y-1";
    default: {
      const unhandled: never = c;
      return unhandled;
    }
  }
}

/** The headline figure: a day's total, or a rate or latency right now. */
function formatValue(id: KpiId, value: number): string {
  switch (id) {
    case "orders":
    case "audience":
    case "errors":
    case "cancellations":
      return formatCount(Math.round(value));
    case "conversion":
      return `${(value * 100).toFixed(2)}%`;
    case "latency":
      return formatMs(value);
    default: {
      const unhandled: never = id;
      return unhandled;
    }
  }
}

/** A plotted value: a count per interval, a percentage, milliseconds. */
function formatPoint(id: KpiId, value: number): string {
  switch (id) {
    case "orders":
    case "audience":
    case "errors":
    case "cancellations":
      return formatCount(Math.round(value));
    case "conversion":
      return `${value.toFixed(2)}%`;
    case "latency":
      return formatMs(value);
    default: {
      const unhandled: never = id;
      return unhandled;
    }
  }
}

function formatTick(id: KpiId, value: number): string {
  switch (id) {
    case "orders":
    case "audience":
    case "errors":
    case "cancellations":
    case "latency":
      return formatCount(value);
    case "conversion":
      return `${Number(value.toFixed(2))}%`;
    default: {
      const unhandled: never = id;
      return unhandled;
    }
  }
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

/** The day so far plus an hour, so today fills the plot instead of half of it. */
export const domainEnd = (lastBucket: number) =>
  Math.min(BUCKETS_PER_DAY - 1, lastBucket + 60 / BUCKET_MINUTES);

export const bucketTime = (bucket: number) => {
  const minutes = Math.round(bucket * BUCKET_MINUTES);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};

interface PlotPoint {
  bucket: number;
  value: number | null;
  reference: number | null;
  /** Where the day is heading, past now; also on the last point so it joins. */
  projected: number | null;
  /** Every reference day at this point, for charts that draw several. */
  refs: Record<Comparison, number | null>;
  /** The normal range, for a rate. */
  band: [number, number] | null;
}

const BAR_BUCKETS = 15 / BUCKET_MINUTES;
const HOUR_BUCKETS = 60 / BUCKET_MINUTES;
/** Counts, summed per 15 minutes rather than smoothed. */
const perQuarter = (shape: Shape) => shape === "bars" || shape === "lines";
/** The window a count is summed over: an hour for sparse bars, else 15 min. */
const windowOf = (shape: Shape) =>
  shape === "bars" ? HOUR_BUCKETS : BAR_BUCKETS;
const SMOOTH_BUCKETS = 30 / BUCKET_MINUTES;
/** How far a rate may sit from the same time yesterday and still be normal. */
const BAND_WIDTH = 0.1;

const mean = (values: number[]) =>
  values.length === 0
    ? null
    : values.reduce((a, b) => a + b, 0) / values.length;

/** Counts, summed per window (15 minutes unless told otherwise). */
function perQuarterHour(
  points: readonly MetricPoint[],
  comparison: Comparison,
  size: number = BAR_BUCKETS,
): PlotPoint[] {
  const groups = new Map<number, MetricPoint[]>();
  for (const p of points) {
    const key = Math.floor(p.bucket / size);
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.entries()].map(([key, group]) => {
    const sumOf = (k: "value" | Comparison) =>
      group.every((p) => p[k] === null)
        ? null
        : group.reduce((n, p) => n + (p[k] ?? 0), 0);
    return {
      bucket: key * size + (size - 1) / 2,
      value: sumOf("value"),
      reference: sumOf(comparison),
      projected: null,
      refs: { d1: sumOf("d1"), w1: sumOf("w1"), y1: sumOf("y1") },
      band: null,
    };
  });
}

/** Levels and volumes, as a trailing 30-minute mean (never waits on the future). */
function smoothed(
  points: readonly MetricPoint[],
  band: boolean,
  comparison: Comparison,
): PlotPoint[] {
  return points.map((p, i) => {
    const window = points.slice(Math.max(0, i - SMOOTH_BUCKETS + 1), i + 1);
    const pick = (k: "value" | Comparison) =>
      mean(window.flatMap((w) => (w[k] === null ? [] : [w[k]])));
    const reference = pick(comparison);
    return {
      bucket: p.bucket,
      value: pick("value"),
      reference,
      projected: null,
      refs: { d1: pick("d1"), w1: pick("w1"), y1: pick("y1") },
      band:
        band && reference !== null
          ? [reference * (1 - BAND_WIDTH), reference * (1 + BAND_WIDTH)]
          : null,
    };
  });
}

/** Where a change falls on the day's axis: its minutes since local midnight. */
function changeBucket(change: Deploy, dayStart: number): number {
  return Math.max(
    0,
    Math.round((Date.parse(change.at) - dayStart) / 60_000 / BUCKET_MINUTES),
  );
}

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

/** The changes the reader is pointing at, lit on every chart on the page. */
const ChangeFocus = createContext<{
  focused: readonly string[];
  setFocused: (ids: readonly string[]) => void;
}>({ focused: [], setFocused: () => {} });

export function ChangeFocusProvider({ children }: { children: ReactNode }) {
  const [focused, setFocused] = useState<readonly string[]>([]);
  return (
    <ChangeFocus.Provider value={{ focused, setFocused }}>
      {children}
    </ChangeFocus.Provider>
  );
}

/** The hour a deploy's verdict is measured on. */
const HOUR_AFTER = 60 / BUCKET_MINUTES;

const VERDICT_RANK: Record<DeployVerdict, number> = {
  regression: 3,
  improvement: 2,
  settling: 1,
  neutral: 0,
};

const VERDICT_TINT: Record<DeployVerdict, string> = {
  regression: "var(--destructive)",
  improvement: "var(--success)",
  settling: "var(--muted-foreground)",
  neutral: "var(--muted-foreground)",
};

const VERDICT_BADGE: Record<DeployVerdict, string> = {
  regression: "bg-destructive/10 text-destructive",
  improvement: "bg-success/10 text-success",
  settling: "bg-muted text-muted-foreground",
  neutral: "bg-muted text-muted-foreground",
};

interface ChangeGroup {
  bucket: number;
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
    (a, b) => changeBucket(a, dayStart) - changeBucket(b, dayStart),
  );
  for (const change of sorted) {
    const bucket = changeBucket(change, dayStart);
    const last = groups.at(-1);
    const lastBucket = last
      ? changeBucket(last.changes.at(-1) as Deploy, dayStart)
      : null;
    if (last && lastBucket !== null && bucket - lastBucket <= gap) {
      last.changes.push(change);
    } else {
      groups.push({ bucket, changes: [change] });
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
                reference={kpiLabel(i.metric, t)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A marker's card, opened by pointing at it or focusing it, on this chart
 * only: the line it lights is shared, the card is not.
 */
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
}: {
  changes: readonly Deploy[];
  dayStart: number;
  end: number;
}) {
  const t = useT();
  const { focused, setFocused } = useContext(ChangeFocus);
  return (
    <div className="relative h-5" style={{ marginRight: Y_AXIS_WIDTH }}>
      {groupChanges(changes, dayStart, end).map((group) => {
        const ids = group.changes.map((c) => c.id);
        const first = group.changes[0] as Deploy;
        const verdict = worstVerdict(group.changes);
        const rollout = group.changes.some((c) => c.kind === "rollout");
        const lit = ids.some((id) => focused.includes(id));
        const time = bucketTime(group.bucket);
        return (
          <ChangeMarker
            key={first.id}
            onOpenChange={(open) => setFocused(open ? ids : [])}
            trigger={
              <button
                type="button"
                aria-label={
                  group.changes.length > 1
                    ? t("monitor.chart.changesAt", {
                        count: String(group.changes.length),
                        time,
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
                style={{ left: `${(group.bucket / end) * 100}%` }}
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
                    time={bucketTime(changeBucket(change, dayStart))}
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

function PointTooltip({
  active,
  payload,
  kpi,
  shape,
  changes,
  dayStart,
  comparison,
  shown,
  hourly,
}: {
  active?: boolean;
  payload?: { payload?: PlotPoint }[];
  kpi: Kpi;
  shape: Shape;
  changes: readonly Deploy[];
  dayStart: number;
  comparison: Comparison;
  shown: readonly Comparison[];
  /** Each point is an hour's total, so the window it covers is the hour. */
  hourly: boolean;
}) {
  const t = useT();
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const size = shape === "lines" && hourly ? HOUR_BUCKETS : windowOf(shape);
  const from = Math.floor(point.bucket / size) * size;
  const near = changes.filter(
    (c) =>
      Math.abs(
        changeBucket(c, dayStart) -
          (perQuarter(shape) ? from + (size - 1) / 2 : point.bucket),
      ) <= (perQuarter(shape) ? size / 2 + 0.5 : 1),
  );
  const span = perQuarter(shape)
    ? t("monitor.chart.range", {
        from: bucketTime(from),
        to: bucketTime(from + size),
      })
    : bucketTime(point.bucket);
  return (
    <div className="min-w-44 rounded-lg border bg-background px-3 py-2 shadow-md">
      <div className="mb-1 text-xs text-muted-foreground">{span}</div>
      <div className="flex flex-col gap-1">
        {point.value === null && point.projected !== null && (
          <div className="flex items-center gap-1.5 text-xs">
            <ProjectionSwatch />
            <span className="text-muted-foreground">
              {t("monitor.chart.projection")}
            </span>
            <span className="tnum ml-auto pl-3 font-medium">
              {formatPoint(kpi.id, point.projected)}
            </span>
          </div>
        )}
        {point.value !== null && (
          <div className="flex items-center gap-1.5 text-xs">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: COLOR_TODAY }}
            />
            <span className="text-muted-foreground">
              {t("monitor.chart.today")}
            </span>
            <span className="tnum ml-auto pl-3 font-medium">
              {formatPoint(kpi.id, point.value)}
            </span>
          </div>
        )}
        {shape === "lines" ? (
          shown.map((c) =>
            point.refs[c] === null ? null : (
              <div key={c} className="flex items-center gap-1.5 text-xs">
                <ReferenceSwatch comparison={c} />
                <span className="text-muted-foreground">
                  {comparisonLabel(c, t)}
                </span>
                <span className="tnum ml-auto pl-3 font-medium">
                  {formatPoint(kpi.id, point.refs[c])}
                </span>
              </div>
            ),
          )
        ) : point.band ? (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="size-2 shrink-0 rounded-sm bg-muted-foreground/30" />
            <span className="text-muted-foreground">
              {t("monitor.chart.normal")}
            </span>
            <span className="tnum ml-auto pl-3 font-medium">
              {t("monitor.chart.range", {
                from: formatPoint(kpi.id, point.band[0]),
                to: formatPoint(kpi.id, point.band[1]),
              })}
            </span>
          </div>
        ) : (
          point.reference !== null && (
            <div className="flex items-center gap-1.5 text-xs">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: COLOR_REFERENCE }}
              />
              <span className="text-muted-foreground">
                {comparisonLabel(comparison, t)}
              </span>
              <span className="tnum ml-auto pl-3 font-medium">
                {formatPoint(kpi.id, point.reference)}
              </span>
            </div>
          )
        )}
        {kpi.threshold !== undefined && (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="h-0 w-2 shrink-0 border-t border-dashed border-destructive" />
            <span className="text-muted-foreground">
              {t("monitor.chart.target")}
            </span>
            <span className="tnum ml-auto pl-3 font-medium">
              {formatPoint(kpi.id, kpi.threshold)}
            </span>
          </div>
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
                {bucketTime(changeBucket(change, dayStart))}
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
  comparison,
  projection,
  hourly,
}: {
  kpi: Kpi;
  shape: Shape;
  comparison: Comparison;
  projection: boolean;
  /** The points are whole hours, as the order monitor's live ones are. */
  hourly: boolean;
}) {
  const t = useT();
  return (
    <div className="text-meta flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="flex items-center gap-1.5">
        {shape === "bars" ? (
          <span
            className={cn(
              "size-2 rounded-sm",
              kpi.id === "orders" ? "bg-chart-1" : "bg-muted-foreground/70",
            )}
          />
        ) : (
          <span className="h-0.5 w-3 rounded-full bg-chart-1" />
        )}
        {shape === "bars" || hourly
          ? t("monitor.chart.todayPerHour")
          : perQuarter(shape)
            ? t("monitor.chart.todayPer15")
            : t("monitor.chart.todayMean")}
      </span>
      {projection && (
        <span className="flex items-center gap-1.5">
          <ProjectionSwatch />
          {t("monitor.chart.projection")}
        </span>
      )}
      {/* Orders name their reference days on the toggles above the chart. */}
      {shape === "lines" ? null : shape === "band" ? (
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm bg-muted-foreground/20" />
          {t("monitor.chart.normal")}
        </span>
      ) : (
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "w-3 rounded-full",
              shape === "bars"
                ? "h-0.5 bg-foreground/55"
                : "h-0.5 bg-muted-foreground/50",
            )}
          />
          {comparisonLabel(comparison, t)}
        </span>
      )}
      {kpi.id !== "orders" && shape === "bars" && (
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
  points,
  projection,
  changes,
  comparison,
  shown,
  dayStart,
}: {
  kpi: Kpi;
  points: MetricPoint[];
  projection: MetricPoint[] | undefined;
  changes: readonly Deploy[];
  comparison: Comparison;
  /** The reference days drawn, on a chart of lines. */
  shown: readonly Comparison[];
  dayStart: number;
}) {
  const t = useT();
  const { focused } = useContext(ChangeFocus);
  const pointer = usePointer();
  const shape = SHAPE[kpi.id];
  const lastBucket = points.at(-1)?.bucket ?? 0;
  const ahead = shape === "lines" && (projection?.length ?? 0) > 0;
  // A projected day is drawn to midnight; otherwise today fills the plot.
  const end = ahead ? BUCKETS_PER_DAY - 1 : domainEnd(lastBucket);
  // Summed over the whole day at once, so the quarter hour under way holds
  // what has come in plus what is projected for the rest of it.
  const quarters = perQuarterHour(
    ahead ? [...points, ...(projection ?? [])] : points,
    comparison,
  );
  // A line would dive into the quarter hour still under way; bars show it as
  // the short bar it is. On a projected day that quarter is projection.
  // Only 5-minute points can end mid-quarter; hourly ones end on a full hour.
  const dense = (points[1]?.bucket ?? 0) - (points[0]?.bucket ?? 0) === 1;
  const partial = dense && (lastBucket + 1) % BAR_BUCKETS !== 0;
  const lastDone = Math.floor(lastBucket / BAR_BUCKETS) - (partial ? 1 : 0);
  const quarterOf = (p: PlotPoint) => Math.floor(p.bucket / BAR_BUCKETS);
  const lines = quarters.flatMap((p) => {
    const q = quarterOf(p);
    if (q <= lastDone) {
      return [{ ...p, projected: ahead && q === lastDone ? p.value : null }];
    }
    return ahead ? [{ ...p, value: null, projected: p.value }] : [];
  });
  const data =
    shape === "lines"
      ? lines
      : shape === "bars"
        ? perQuarterHour(points, comparison, HOUR_BUCKETS)
        : smoothed(points, shape === "band", comparison);
  const gradient = `monitor-${kpi.id}`;
  const values = data.flatMap((p) =>
    [
      p.value,
      p.projected,
      ...(shape === "lines" ? shown.map((c) => p.refs[c]) : [p.reference]),
      ...(p.band ?? []),
    ].filter((v): v is number => v !== null),
  );
  const lo = Math.min(...values, kpi.threshold ?? Number.POSITIVE_INFINITY);
  const hi = Math.max(...values, kpi.threshold ?? 0);
  // Counts start at zero; a level's axis hugs the data with room around it,
  // so a few tenths of a point read as the small move they are.
  const pad = (hi - lo) * 0.4;
  const scale =
    shape === "lines" || shape === "bars" || shape === "area"
      ? niceScale(0, hi)
      : niceScale(Math.max(0, lo - pad), hi + pad);
  // Errors read like Sentry's: quiet bars, and only a window well above
  // yesterday's turns red, so the spike is what the eye finds.
  const barFill = (p: PlotPoint) =>
    kpi.id === "orders"
      ? COLOR_TODAY
      : (p.value ?? 0) >
          Math.max((p.reference ?? 0) * 1.8, (p.reference ?? 0) + 3)
        ? "var(--destructive)"
        : "var(--muted-foreground)";
  return (
    <div className="flex flex-col gap-1">
      {/* Always there, empty or not, so deploys arriving or being toggled
          never push the plot down. */}
      <ChangeLane changes={changes} dayStart={dayStart} end={end} />
      <ChartContainer
        {...pointer.bind}
        role="img"
        aria-label={kpiLabel(kpi.id, t)}
        className="h-[150px] w-full md:h-[170px]"
        config={{
          value: { label: t("monitor.chart.today"), color: COLOR_TODAY },
          reference: {
            label: comparisonLabel(comparison, t),
            color: COLOR_REFERENCE,
          },
        }}
      >
        <ComposedChart
          data={data}
          syncId={SYNC_ID}
          syncMethod="value"
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
            dataKey="bucket"
            type="number"
            domain={[0, end]}
            ticks={HOUR_TICKS.filter((tick) => tick <= end)}
            axisLine={false}
            tickLine={false}
            tick={AXIS_TICK}
            tickMargin={8}
            tickFormatter={bucketTime}
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
                active={active && pointer.over}
                payload={payload as { payload?: PlotPoint }[] | undefined}
                kpi={kpi}
                shape={shape}
                changes={changes}
                dayStart={dayStart}
                comparison={comparison}
                shown={shown}
                hourly={!dense}
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
                x1={changeBucket(change, dayStart)}
                x2={Math.min(end, changeBucket(change, dayStart) + HOUR_AFTER)}
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
                x={changeBucket(change, dayStart)}
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
          {shape === "band" && (
            <Area
              dataKey="band"
              stroke="none"
              fill="var(--muted-foreground)"
              fillOpacity={0.12}
              activeDot={false}
              isAnimationActive={false}
            />
          )}
          {shape === "bars" ? (
            <Bar
              dataKey="value"
              fillOpacity={0.55}
              radius={[3, 3, 0, 0]}
              barSize={14}
              isAnimationActive={false}
            >
              {data.map((p) => (
                <Cell key={p.bucket} fill={barFill(p)} />
              ))}
            </Bar>
          ) : null}
          {shape === "bars" && (
            // The reference hour as a tick across its bar, like a bullet chart.
            <Scatter
              dataKey="reference"
              isAnimationActive={false}
              shape={ReferenceTick}
            />
          )}
          {shape === "lines" &&
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
          {(shape === "area" || shape === "threshold") && (
            <Line
              type="monotone"
              dataKey="reference"
              stroke={COLOR_REFERENCE}
              strokeOpacity={0.55}
              strokeWidth={1.25}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
          )}
          {ahead && (
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
          {(shape === "band" || shape === "threshold") && (
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
        comparison={comparison}
        projection={ahead}
        hourly={!dense}
      />
    </div>
  );
}

/**
 * Which reference days a chart draws, in its top-right corner: any of them
 * on the orders chart, one at a time on the others. On orders each one also
 * carries that day's total and how today compares, as the order monitor's
 * headline does, and shows its stroke on the chart.
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
        <span className="font-medium">{comparisonShort(c)}</span>
        {multiple && kpi.value !== null && ref !== null && (
          <>
            <span className="tnum text-muted-foreground">
              {formatValue(kpi.id, ref)}
            </span>
            <Trend
              change={relativeChange(kpi.value, ref)}
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
    >
      {items}
    </ToggleGroup>
  );
}

/**
 * The headline number. Orders' is the day projected to midnight, not what has
 * come in, so it says so beside it.
 */
function Figure({ kpi, value }: { kpi: Kpi; value: number }) {
  const t = useT();
  return (
    <span className="flex items-baseline gap-2">
      {formatValue(kpi.id, value)}
      {kpi.projection && (
        <span className="text-meta font-sans tracking-normal">
          {t("monitor.chart.projectedLabel")}
        </span>
      )}
    </span>
  );
}

export function MetricChart({
  kpi,
  changes,
  showChanges,
  dayStart,
  sourceName,
  icon,
  connect,
  preview,
  waiting = false,
  bare = false,
  className,
}: {
  kpi: Kpi;
  /** The day's deploys and rollouts. */
  changes: readonly Deploy[];
  showChanges: boolean;
  /** Local midnight of the day on screen, as an ISO instant. */
  dayStart: string;
  sourceName: string;
  icon: string | null;
  connect: LinkProps;
  /**
   * What this card would show, for one whose source isn't feeding it yet:
   * drawn faded behind the button that connects it.
   */
  preview?: Kpi;
  /** The source is connected but nothing has arrived yet. */
  waiting?: boolean;
  /** Under the page's own connect card: the faded preview, no button. */
  bare?: boolean;
  className?: string;
}) {
  const t = useT();
  const title = kpiLabel(kpi.id, t);
  // Each chart picks its own reference days; a week ago to start with.
  const [shown, setShown] = useState<Comparison[]>(["w1"]);
  const multiple = SHAPE[kpi.id] === "lines";
  const comparison = shown[0] ?? "w1";
  const sourceIcon = (
    <IntegrationIcon icon={icon} name={sourceName} size="xs" fit="cover" />
  );
  if (kpi.value === null && preview?.value != null && preview.points) {
    return (
      <div className={cn("min-w-0", className)}>
        <MetricCard title={title} aside={sourceIcon}>
          <div className="relative -mt-4">
            <div aria-hidden className={FADED}>
              <span className="tnum text-4xl font-normal text-foreground">
                <Figure kpi={preview} value={preview.value} />
              </span>
              <Plot
                kpi={preview}
                points={preview.points}
                projection={preview.projection}
                changes={[]}
                comparison="w1"
                shown={["w1"]}
                dayStart={Date.parse(dayStart)}
              />
            </div>
            <div
              className={cn(
                "absolute inset-0 flex items-center justify-center",
                bare && "hidden",
              )}
            >
              {waiting ? (
                <span className="text-meta glass rounded-full px-3 py-1.5">
                  {t("monitor.waiting")}
                </span>
              ) : (
                <ConnectButton
                  label={connectLabel(kpi.source, t)}
                  link={connect}
                  source={kpi.source}
                />
              )}
            </div>
          </div>
        </MetricCard>
      </div>
    );
  }
  if (kpi.value === null) {
    return (
      <Link
        {...connect}
        className={cn(
          "focus-ring flex h-full min-w-0 flex-col gap-6 rounded-xl border border-dashed border-border px-4 pt-4 pb-5 transition-colors hover:bg-accent/50",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-sm text-foreground/70">{title}</h3>
          {sourceIcon}
        </div>
        <span className="mt-auto flex items-center gap-1.5 text-sm text-foreground">
          <Plus size={14} />
          {connectLabel(kpi.source, t)}
        </span>
      </Link>
    );
  }
  return (
    <div className={cn("min-w-0", className)}>
      <MetricCard
        title={title}
        value={<Figure kpi={kpi} value={kpi.value} />}
        caption={
          // Orders compare on the toggles themselves; what is left is the count so far.
          kpi.id === "orders" ? (
            kpi.soFar !== undefined && (
              <span className="text-meta">
                {t("monitor.chart.soFar", { count: formatCount(kpi.soFar) })}
              </span>
            )
          ) : (
            <Trend
              change={relativeChange(kpi.value, kpi.references[comparison])}
              better={BETTER[kpi.id]}
              reference={t("monitor.compare.vs", {
                ref: comparisonLabel(comparison, t),
              })}
            />
          )
        }
        aside={
          <div className="flex shrink-0 items-center gap-3">
            {kpi.points && (
              <ReferencePicker
                kpi={kpi}
                multiple={multiple}
                shown={shown}
                onShown={setShown}
              />
            )}
            {sourceIcon}
          </div>
        }
      >
        {kpi.points && (
          <Plot
            kpi={kpi}
            points={kpi.points}
            projection={kpi.projection}
            changes={showChanges ? changes : []}
            comparison={comparison}
            shown={shown}
            dayStart={Date.parse(dayStart)}
          />
        )}
      </MetricCard>
    </div>
  );
}

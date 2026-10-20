/**
 * One store's day as the order monitor judged it: the headline, the Orders
 * chart (today vs D-1 / W-1 / Y-1, expected with its projection, the alert
 * band) and the Cancellations chart, with pushes to main marked on both.
 * Shared by the agent Monitor tab and the org Monitoring page's Stores tab.
 */

import { useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  ORDER_MONITOR_RULES,
  type OrderMonitorDay,
  type OrderMonitorPushes,
  type OrderMonitorRule,
  type OrderMonitorStatus,
} from "@decocms/shared/order-monitor";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import {
  useOrderMonitorDay,
  useOrderMonitorPushes,
} from "@/hooks/use-order-monitor";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21];
/** YAxis width and right margin: the push strips line up with the plot area. */
const Y_AXIS_WIDTH = 40;
const RIGHT_MARGIN = 8;

const COLOR_TODAY = "var(--chart-1)";
const COLOR_D1 = "var(--chart-2)";
const COLOR_W1 = "var(--chart-3)";
const COLOR_Y1 = "var(--chart-4)";
const COLOR_EXPECTED = "var(--chart-5)";
const REPO_DOTS = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
];

const STATUS_VARIANT: Record<
  OrderMonitorStatus,
  "success" | "warning" | "destructive" | "muted"
> = {
  ok: "success",
  warning: "warning",
  alert: "destructive",
  "low-volume": "muted",
};

function statusLabel(status: OrderMonitorStatus, t: TFunction): string {
  switch (status) {
    case "ok":
      return t("orderMonitor.status.ok");
    case "warning":
      return t("orderMonitor.status.warning");
    case "alert":
      return t("orderMonitor.status.alert");
    case "low-volume":
      return t("orderMonitor.status.lowVolume");
  }
}

export function ruleLabel(rule: OrderMonitorRule, t: TFunction): string {
  switch (rule) {
    case "orders_drop":
      return t("orderMonitor.rule.ordersDrop");
    case "denied_spike":
      return t("orderMonitor.rule.deniedSpike");
    case "cancel_spike":
      return t("orderMonitor.rule.cancelSpike");
  }
}

export function OrderMonitorStatusBadge({
  status,
}: {
  status: OrderMonitorStatus;
}) {
  const t = useT();
  return (
    <Badge variant={STATUS_VARIANT[status]}>{statusLabel(status, t)}</Badge>
  );
}

/** `HH:MM` of a 15-minute bucket of the local day. */
function bucketTime(bucket: number): string {
  // A window in the first hour starts the day before (negative bucket).
  const minutes = ((bucket + 96) % 96) * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** The UTC offset of `tz` at `instant`, in ms. */
function tzOffsetMs(instant: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The last second of a local day in `tz`, as an ISO instant. */
function endOfLocalDay(date: string, tz: string): string {
  const guess = Date.parse(`${date}T23:59:59Z`);
  return new Date(guess - tzOffsetMs(new Date(guess), tz)).toISOString();
}

const sum = (values: (number | null)[]) =>
  values.reduce<number>((s, v) => s + (v ?? 0), 0);

function percentVs(projected: number, reference: number): string {
  if (reference <= 0) return "—";
  const pct = Math.round((projected / reference - 1) * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

function Headline({ day }: { day: OrderMonitorDay }) {
  const t = useT();
  const drop = day.verdicts.orders_drop;
  const refs = [
    { label: t("orderMonitor.series.d1"), total: day.headline.d1 },
    { label: t("orderMonitor.series.w1"), total: day.headline.w1 },
    { label: t("orderMonitor.series.y1"), total: day.headline.y1 },
  ];
  return (
    <div className="flex flex-wrap items-end gap-6">
      <div>
        <p className="text-xs text-muted-foreground">
          {t("orderMonitor.projected")}
        </p>
        <p className="text-2xl font-semibold tabular-nums text-foreground">
          {Math.round(day.headline.projected).toLocaleString()}
        </p>
      </div>
      {refs.map((ref) => (
        <div key={ref.label}>
          <p className="text-xs text-muted-foreground">{ref.label}</p>
          <p className="text-sm tabular-nums text-foreground">
            {ref.total.toLocaleString()}{" "}
            <span className="text-muted-foreground">
              {percentVs(day.headline.projected, ref.total)}
            </span>
          </p>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <OrderMonitorStatusBadge status={drop.status} />
        {drop.ingestIncident && (
          <Badge variant="muted">{t("orderMonitor.ingestIncident")}</Badge>
        )}
      </div>
    </div>
  );
}

/** One row per repo, a dot per push bucket, aligned with the chart's plot area. */
function PushStrips({ pushes }: { pushes: OrderMonitorPushes | undefined }) {
  const t = useT();
  const repos = (pushes?.repos ?? []).filter((r) => r.markers.length > 0);
  if (repos.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {repos.map((repo, i) => (
        <div key={repo.repositoryId} className="flex items-center gap-2">
          <div
            className="relative h-4 flex-1 border-b border-dashed border-border"
            style={{ marginLeft: Y_AXIS_WIDTH, marginRight: RIGHT_MARGIN }}
          >
            {repo.markers.map((marker) => (
              <Tooltip key={marker.bucket}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("orderMonitor.pushAt", {
                      repo: repo.name,
                      time: bucketTime(marker.bucket),
                    })}
                    className={cn(
                      "absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
                      REPO_DOTS[i % REPO_DOTS.length],
                    )}
                    style={{ left: `${(marker.bucket / 96) * 100}%` }}
                  />
                </TooltipTrigger>
                <TooltipContent className="max-w-80">
                  <p className="font-medium">
                    {repo.name} · {bucketTime(marker.bucket)}
                  </p>
                  {marker.commits.map((commit) => (
                    <p key={commit.sha} className="truncate">
                      {commit.message}{" "}
                      <span className="opacity-70">— {commit.author}</span>
                    </p>
                  ))}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
          <span className="w-32 shrink-0 truncate text-xs text-muted-foreground">
            {repo.name}
          </span>
        </div>
      ))}
    </div>
  );
}

function pushLines(pushes: OrderMonitorPushes | undefined) {
  return (pushes?.repos ?? []).flatMap((repo) =>
    repo.markers.map((marker) => (
      <ReferenceLine
        key={`${repo.repositoryId}:${marker.bucket}`}
        x={marker.bucket / 4}
        stroke="var(--muted-foreground)"
        strokeDasharray="2 3"
        strokeOpacity={0.6}
      />
    )),
  );
}

const xAxis = (
  <XAxis
    dataKey="x"
    type="number"
    domain={[0, 24]}
    ticks={HOUR_TICKS}
    tickLine={false}
    axisLine={false}
    tickMargin={8}
    tickFormatter={(h: number) => hourLabel(h)}
  />
);

const yAxis = (
  <YAxis
    tickLine={false}
    axisLine={false}
    width={Y_AXIS_WIDTH}
    allowDecimals={false}
  />
);

type Datum = { x: number };

function datumHour(payload: unknown): number | null {
  if (!Array.isArray(payload)) return null;
  const first: unknown = payload[0];
  if (!first || typeof first !== "object" || !("payload" in first)) return null;
  const datum = first.payload;
  return datum && typeof datum === "object" && "x" in datum
    ? Number((datum as Datum).x)
    : null;
}

function OrdersChart({
  day,
  pushes,
}: {
  day: OrderMonitorDay;
  pushes: OrderMonitorPushes | undefined;
}) {
  const t = useT();
  const { orders } = day;
  const current = Math.floor(day.done / 4);
  const drop = day.verdicts.orders_drop;
  const data = HOURS.map((h) => {
    const warn = orders.warnAt[h];
    const alert = orders.alertAt[h];
    return {
      x: h,
      today: orders.today[h],
      d1: orders.d1[h],
      w1: orders.w1[h],
      y1: orders.y1[h],
      expected: h <= current ? orders.expected[h] : null,
      projection: h >= current && current < 24 ? orders.expected[h] : null,
      band:
        warn !== null &&
        warn !== undefined &&
        alert !== null &&
        alert !== undefined
          ? [alert, warn]
          : null,
    };
  });
  return (
    <ChartContainer
      config={{
        today: { label: t("orderMonitor.series.today"), color: COLOR_TODAY },
        d1: { label: t("orderMonitor.series.d1"), color: COLOR_D1 },
        w1: { label: t("orderMonitor.series.w1"), color: COLOR_W1 },
        y1: { label: t("orderMonitor.series.y1"), color: COLOR_Y1 },
        expected: {
          label: t("orderMonitor.series.expected"),
          color: COLOR_EXPECTED,
        },
        projection: {
          label: t("orderMonitor.series.projection"),
          color: COLOR_EXPECTED,
        },
      }}
      className="h-72 w-full"
    >
      <ComposedChart
        data={data}
        margin={{ top: 8, right: RIGHT_MARGIN, bottom: 0, left: 0 }}
      >
        <CartesianGrid vertical={false} />
        {xAxis}
        {yAxis}
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                const h = datumHour(payload);
                if (h === null) return null;
                if (h === Math.floor(drop.from / 4)) {
                  return t("orderMonitor.verdictWindow", {
                    hour: hourLabel(h),
                    from: bucketTime(drop.from),
                    to: bucketTime(drop.to),
                    observed: drop.observed,
                    expected: Math.round(drop.expected),
                  });
                }
                return hourLabel(h);
              }}
            />
          }
        />
        <Area
          dataKey="band"
          stroke="none"
          fill="var(--warning)"
          fillOpacity={0.15}
          tooltipType="none"
          isAnimationActive={false}
        />
        {pushLines(pushes)}
        <Line
          dataKey="y1"
          stroke={COLOR_Y1}
          strokeWidth={1.5}
          strokeOpacity={0.6}
          dot={false}
        />
        <Line
          dataKey="w1"
          stroke={COLOR_W1}
          strokeWidth={1.5}
          strokeOpacity={0.7}
          dot={false}
        />
        <Line
          dataKey="d1"
          stroke={COLOR_D1}
          strokeWidth={1.5}
          strokeOpacity={0.8}
          dot={false}
        />
        <Line
          dataKey="expected"
          stroke={COLOR_EXPECTED}
          strokeWidth={1.5}
          dot={false}
        />
        <Line
          dataKey="projection"
          stroke={COLOR_EXPECTED}
          strokeWidth={1.5}
          strokeDasharray="4 4"
          dot={false}
        />
        <Line
          dataKey="today"
          stroke={COLOR_TODAY}
          strokeWidth={2.5}
          dot={false}
        />
      </ComposedChart>
    </ChartContainer>
  );
}

function CancellationsChart({
  day,
  pushes,
}: {
  day: OrderMonitorDay;
  pushes: OrderMonitorPushes | undefined;
}) {
  const t = useT();
  const [kind, setKind] = useState<"canceled" | "denied">("canceled");
  const { cancellations } = day;
  const series = cancellations[kind];
  const approx = cancellations.approximate;
  const withApprox = (label: string, approximate: boolean) =>
    approximate ? `${label} (${t("orderMonitor.approximate")})` : label;
  const data = HOURS.map((h) => {
    const warn = cancellations.canceledWarnAt[h];
    const alert = cancellations.canceledAlertAt[h];
    return {
      x: h,
      today: series.today[h],
      d1: series.d1[h],
      w1: series.w1[h],
      y1: series.y1[h],
      band:
        kind === "canceled" &&
        warn !== null &&
        warn !== undefined &&
        alert !== null &&
        alert !== undefined
          ? [warn, alert]
          : null,
    };
  });
  const kinds = [
    { id: "canceled" as const, label: t("orderMonitor.canceled") },
    { id: "denied" as const, label: t("orderMonitor.denied") },
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-0.5 self-start rounded-lg border border-border p-0.5">
        {kinds.map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => setKind(k.id)}
            className={cn(
              "rounded-lg px-3 py-1 text-xs font-medium transition-colors",
              kind === k.id
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {k.label}
          </button>
        ))}
      </div>
      <ChartContainer
        config={{
          today: { label: t("orderMonitor.series.today"), color: COLOR_TODAY },
          d1: {
            label: withApprox(t("orderMonitor.series.d1"), approx.d1),
            color: COLOR_D1,
          },
          w1: {
            label: withApprox(t("orderMonitor.series.w1"), approx.w1),
            color: COLOR_W1,
          },
          y1: {
            label: withApprox(t("orderMonitor.series.y1"), approx.y1),
            color: COLOR_Y1,
          },
        }}
        className="h-56 w-full"
      >
        <ComposedChart
          data={data}
          margin={{ top: 8, right: RIGHT_MARGIN, bottom: 0, left: 0 }}
        >
          <CartesianGrid vertical={false} />
          {xAxis}
          {yAxis}
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) => {
                  const h = datumHour(payload);
                  return h === null ? null : hourLabel(h);
                }}
              />
            }
          />
          <Area
            dataKey="band"
            stroke="none"
            fill="var(--warning)"
            fillOpacity={0.15}
            tooltipType="none"
            isAnimationActive={false}
          />
          {pushLines(pushes)}
          <Line
            dataKey="y1"
            stroke={COLOR_Y1}
            strokeWidth={1.5}
            strokeOpacity={0.6}
            strokeDasharray={approx.y1 ? "4 4" : undefined}
            dot={false}
          />
          <Line
            dataKey="w1"
            stroke={COLOR_W1}
            strokeWidth={1.5}
            strokeOpacity={0.7}
            strokeDasharray={approx.w1 ? "4 4" : undefined}
            dot={false}
          />
          <Line
            dataKey="d1"
            stroke={COLOR_D1}
            strokeWidth={1.5}
            strokeOpacity={0.8}
            strokeDasharray={approx.d1 ? "4 4" : undefined}
            dot={false}
          />
          <Line
            dataKey="today"
            stroke={COLOR_TODAY}
            strokeWidth={2.5}
            dot={false}
          />
        </ComposedChart>
      </ChartContainer>
      {(approx.d1 || approx.w1 || approx.y1) && (
        <p className="text-xs text-muted-foreground">
          {t("orderMonitor.approximateNote")}
        </p>
      )}
    </div>
  );
}

function Legend() {
  const t = useT();
  const items = [
    { label: t("orderMonitor.series.today"), color: COLOR_TODAY },
    { label: t("orderMonitor.series.d1"), color: COLOR_D1 },
    { label: t("orderMonitor.series.w1"), color: COLOR_W1 },
    { label: t("orderMonitor.series.y1"), color: COLOR_Y1 },
    { label: t("orderMonitor.series.expected"), color: COLOR_EXPECTED },
  ];
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span
            className="h-0.5 w-3 rounded-full"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-3 rounded-sm bg-warning/20" />
        {t("orderMonitor.thresholdBand")}
      </span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function OrderMonitorDayView({
  orgSlug,
  connectionId,
  at,
  onAtChange,
  virtualMcpId,
}: {
  orgSlug: string;
  connectionId: string;
  /** ISO instant to review; undefined = now. */
  at: string | undefined;
  onAtChange: (at: string | undefined) => void;
  /** The agent whose repository the pushes come from; undefined = every agent's. */
  virtualMcpId?: string;
}) {
  const t = useT();
  const dayQuery = useOrderMonitorDay(orgSlug, connectionId, at);
  const pushesQuery = useOrderMonitorPushes(
    orgSlug,
    connectionId,
    at,
    virtualMcpId,
  );
  const day = dayQuery.data;
  const pushes = pushesQuery.data;

  if (dayQuery.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-12 w-80" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }
  if (!day) {
    return (
      <EmptyState
        title={t("orderMonitor.dayErrorTitle")}
        description={dayQuery.error?.message ?? t("orderMonitor.dayErrorBody")}
      />
    );
  }

  const soFar = sum(day.orders.today);
  const verdicts = day.verdicts;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Headline day={day} />
        <div className="flex items-center gap-2">
          <input
            type="date"
            aria-label={t("orderMonitor.pickDay")}
            value={day.date}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => {
              const date = e.target.value;
              if (!date) return;
              onAtChange(endOfLocalDay(date, day.timezone));
            }}
            className="rounded-md border border-border bg-card px-2 py-1 text-xs"
          />
          {at && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onAtChange(undefined)}
            >
              {t("orderMonitor.backToNow")}
            </Button>
          )}
        </div>
      </div>
      {at && (
        <p className="text-xs text-muted-foreground">
          {t("orderMonitor.reviewingAt", {
            at: new Date(at).toLocaleString(),
            timezone: day.timezone,
          })}
        </p>
      )}
      <Section
        title={t("orderMonitor.ordersTitle", {
          count: soFar.toLocaleString(),
        })}
      >
        <Legend />
        <OrdersChart day={day} pushes={pushes} />
        <PushStrips pushes={pushes} />
      </Section>
      <Section title={t("orderMonitor.cancellationsTitle")}>
        <CancellationsChart day={day} pushes={pushes} />
        <PushStrips pushes={pushes} />
      </Section>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {ORDER_MONITOR_RULES.map((rule) => {
          const verdict = verdicts[rule];
          return (
            <div
              key={rule}
              className="flex flex-col gap-1 rounded-lg border border-border p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-foreground">
                  {ruleLabel(rule, t)}
                </span>
                <OrderMonitorStatusBadge status={verdict.status} />
              </div>
              <span className="text-xs tabular-nums text-muted-foreground">
                {t("orderMonitor.observedVsExpected", {
                  observed: verdict.observed,
                  expected: Math.round(verdict.expected),
                  from: bucketTime(verdict.from),
                  to: bucketTime(verdict.to),
                })}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

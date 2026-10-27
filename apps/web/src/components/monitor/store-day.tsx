/**
 * One store's day, in the Monitor's own language: the day's figures as metric
 * cards, orders and cancellations per hour against what was expected and
 * yesterday with every push to main pinned on them, the split by sales
 * channel, and each rule's verdict. Same order-monitor data as the Settings
 * Stores tab, drawn like the rest of the Monitor. The store is a breadcrumb
 * segment under Monitor, so going back is the breadcrumb.
 */

import type { LinkOptions } from "@tanstack/react-router";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@decocms/ui/components/button.tsx";
import { ChartContainer, ChartTooltip } from "@decocms/ui/components/chart.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import {
  ORDER_MONITOR_RULES,
  type OrderMonitorDay,
  type OrderMonitorPushes,
} from "@decocms/shared/order-monitor";
import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
import { ruleLabel } from "@/components/order-monitor/order-monitor-day";
import {
  useOrderMonitorDay,
  useOrderMonitorPushes,
} from "@/hooks/use-order-monitor";
import { useT } from "@/i18n/use-t.ts";
import {
  formatCount,
  relativeChange,
} from "@/layouts/main-panel-tabs/monitor-v8";
import { AXIS_TICK, MetricCard } from "@/layouts/task-board/analytics-sections";
import { type MonitoredStore, sum } from "./board";
import { MonitorStatusMark, Trend } from "./parts";
import { Sparkline } from "./sparkline";

const COLOR_TODAY = "var(--chart-1)";
const COLOR_EXPECTED = "var(--chart-2)";
const COLOR_YESTERDAY = "var(--muted-foreground)";
const Y_AXIS_WIDTH = 40;
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21];
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

interface Point {
  hour: number;
  today: number | null;
  expected: number | null;
  d1: number | null;
  band: [number, number] | null;
}

interface Push {
  key: string;
  hour: number;
  repo: string;
  commits: { sha: string; message: string; author: string }[];
}

function pushesOf(pushes: OrderMonitorPushes | undefined): Push[] {
  return (pushes?.repos ?? []).flatMap((repo) =>
    repo.markers.map((m) => ({
      key: `${repo.repositoryId}:${m.bucket}`,
      hour: m.bucket / 4,
      repo: repo.name,
      commits: m.commits,
    })),
  );
}

function PushTip({ push }: { push: Push }) {
  const t = useT();
  const minutes = Math.round((push.hour % 1) * 60);
  return (
    <div className="flex max-w-72 flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        {t("monitor.chart.deploy")} ·{" "}
        {String(Math.floor(push.hour)).padStart(2, "0")}:
        {String(minutes).padStart(2, "0")} · {push.repo}
      </span>
      {push.commits.map((c) => (
        <span key={c.sha} className="flex flex-col">
          <span className="text-sm font-medium">{c.message}</span>
          <span className="text-xs text-muted-foreground">{c.author}</span>
        </span>
      ))}
    </div>
  );
}

/** Pins above the plot, aligned with its hour axis. */
function PushPins({ pushes }: { pushes: readonly Push[] }) {
  if (pushes.length === 0) return null;
  return (
    <div className="relative h-3" style={{ marginRight: Y_AXIS_WIDTH }}>
      {pushes.map((push) => (
        <Tooltip key={push.key}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={push.commits[0]?.message ?? push.repo}
              className="focus-ring absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-muted-foreground"
              style={{ left: `${(push.hour / 23) * 100}%` }}
            />
          </TooltipTrigger>
          <TooltipContent>
            <PushTip push={push} />
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function HourTooltip({
  active,
  payload,
  pushes,
}: {
  active?: boolean;
  payload?: { payload?: Point }[];
  pushes: readonly Push[];
}) {
  const t = useT();
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const rows = [
    { label: t("monitor.chart.today"), value: point.today, color: COLOR_TODAY },
    {
      label: t("monitor.store.expected"),
      value: point.expected,
      color: COLOR_EXPECTED,
    },
    {
      label: t("monitor.store.yesterday"),
      value: point.d1,
      color: COLOR_YESTERDAY,
    },
  ];
  const near = pushes.filter((p) => Math.floor(p.hour) === point.hour);
  return (
    <div className="rounded-lg border bg-background px-3 py-2 shadow-md">
      <div className="mb-1 text-xs text-muted-foreground">
        {hourLabel(point.hour)}
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((row) =>
          row.value === null ? null : (
            <div key={row.label} className="flex items-center gap-1.5 text-xs">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: row.color }}
              />
              <span className="text-muted-foreground">{row.label}</span>
              <span className="tnum ml-auto pl-3 font-medium">
                {formatCount(Math.round(row.value))}
              </span>
            </div>
          ),
        )}
      </div>
      {near.map((push) => (
        <div key={push.key} className="mt-2 border-t border-border/50 pt-2">
          <PushTip push={push} />
        </div>
      ))}
    </div>
  );
}

function Legend({ band, expected }: { band: boolean; expected: boolean }) {
  const t = useT();
  return (
    <div className="text-meta flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="flex items-center gap-1.5">
        <span className="h-0.5 w-3 rounded-full bg-chart-1" />
        {t("monitor.chart.today")}
      </span>
      {expected && (
        <span className="flex items-center gap-1.5">
          <span className="h-0 w-3 border-t border-dashed border-chart-2" />
          {t("monitor.store.expected")}
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <span className="h-0.5 w-3 rounded-full bg-muted-foreground/50" />
        {t("monitor.store.yesterday")}
      </span>
      {band && (
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-3 rounded-sm bg-warning/20" />
          {t("orderMonitor.thresholdBand")}
        </span>
      )}
    </div>
  );
}

function HourlyChart({
  points,
  pushes,
  label,
}: {
  points: Point[];
  pushes: readonly Push[];
  label: string;
}) {
  const t = useT();
  const hasBand = points.some((p) => p.band !== null);
  const hasExpected = points.some((p) => p.expected !== null);
  // An SVG id: a label with spaces would not resolve and the fill goes black.
  const gradient = `store-${label.replace(/\W+/g, "-")}`;
  return (
    <div className="flex flex-col gap-2">
      <PushPins pushes={pushes} />
      <ChartContainer
        role="img"
        aria-label={label}
        className="h-[200px] w-full md:h-[240px]"
        config={{
          today: { label: t("monitor.chart.today"), color: COLOR_TODAY },
          expected: {
            label: t("monitor.store.expected"),
            color: COLOR_EXPECTED,
          },
          d1: { label: t("monitor.store.yesterday"), color: COLOR_YESTERDAY },
        }}
      >
        <ComposedChart data={points} margin={{ left: 0, right: 0, top: 4 }}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLOR_TODAY} stopOpacity={0.2} />
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
            dataKey="hour"
            type="number"
            domain={[0, 23]}
            ticks={HOUR_TICKS}
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
            allowDecimals={false}
            width={Y_AXIS_WIDTH}
            tickCount={4}
          />
          <ChartTooltip
            cursor={{ stroke: "var(--border)", strokeDasharray: "4 4" }}
            content={({ active, payload }) => (
              <HourTooltip
                active={active}
                payload={payload as { payload?: Point }[] | undefined}
                pushes={pushes}
              />
            )}
          />
          {hasBand && (
            <Area
              dataKey="band"
              stroke="none"
              fill="var(--warning)"
              fillOpacity={0.1}
              tooltipType="none"
              isAnimationActive={false}
            />
          )}
          {pushes.map((push) => (
            <ReferenceLine
              key={push.key}
              x={push.hour}
              stroke="var(--foreground)"
              strokeOpacity={0.18}
              strokeDasharray="3 3"
            />
          ))}
          <Line
            type="monotone"
            dataKey="d1"
            stroke={COLOR_YESTERDAY}
            strokeOpacity={0.5}
            strokeWidth={1.25}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="expected"
            stroke={COLOR_EXPECTED}
            strokeWidth={1.25}
            strokeDasharray="4 4"
            dot={false}
            activeDot={false}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="today"
            stroke={COLOR_TODAY}
            strokeWidth={2}
            fill={`url(#${gradient})`}
            dot={false}
            activeDot={{ r: 3, stroke: "var(--background)", strokeWidth: 2 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ChartContainer>
      <Legend band={hasBand} expected={hasExpected} />
    </div>
  );
}

/** D-1 summed up to the hour today has reached, so both sides cover the same span. */
function d1SoFar(day: OrderMonitorDay, series: number[]): number {
  const hours = day.orders.today.filter((v) => v !== null).length;
  return sum(series.slice(0, hours));
}

function Body({
  day,
  pushes,
}: {
  day: OrderMonitorDay;
  pushes: OrderMonitorPushes | undefined;
}) {
  const t = useT();
  const pins = pushesOf(pushes);
  const soFar = sum(day.orders.today);
  const canceled = sum(day.cancellations.canceled.today);
  const orderPoints: Point[] = day.orders.today.map((today, hour) => {
    const warn = day.orders.warnAt[hour];
    const alert = day.orders.alertAt[hour];
    return {
      hour,
      today,
      expected: day.orders.expected[hour] ?? null,
      d1: day.orders.d1[hour] ?? null,
      band:
        warn !== null &&
        warn !== undefined &&
        alert !== null &&
        alert !== undefined
          ? [alert, warn]
          : null,
    };
  });
  const cancelPoints: Point[] = day.cancellations.canceled.today.map(
    (today, hour) => ({
      hour,
      today,
      expected: null,
      d1: day.cancellations.canceled.d1[hour] ?? null,
      band: null,
    }),
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard
          title={t("monitor.store.projected")}
          value={formatCount(Math.round(day.headline.projected))}
          caption={
            day.backfill ? (
              <span className="text-meta">
                {t("monitor.chart.historyLoading", {
                  pct: `${Math.floor((1 - day.backfill.pending / day.backfill.total) * 100)}%`,
                })}
              </span>
            ) : (
              <Trend
                change={relativeChange(day.headline.projected, day.headline.d1)}
                better="up"
                reference={t("monitor.ref.yesterday")}
              />
            )
          }
        />
        <MetricCard
          title={t("monitor.store.soFar")}
          value={formatCount(soFar)}
          caption={
            <Trend
              change={relativeChange(soFar, d1SoFar(day, day.orders.d1))}
              better="up"
              reference={t("monitor.store.sameTime")}
            />
          }
        />
        <MetricCard
          title={t("monitor.store.canceled")}
          value={formatCount(canceled)}
          caption={
            <Trend
              change={relativeChange(
                canceled,
                d1SoFar(day, day.cancellations.canceled.d1),
              )}
              better="down"
              reference={t("monitor.store.sameTime")}
            />
          }
        />
      </div>
      <MetricCard title={t("monitor.store.ordersPerHour")}>
        <HourlyChart
          points={orderPoints}
          pushes={pins}
          label={t("monitor.store.ordersPerHour")}
        />
      </MetricCard>
      <div className="grid gap-4 md:grid-cols-2">
        {day.channels.length > 0 && (
          <MetricCard title={t("monitor.store.channels")}>
            <ul className="flex flex-col">
              {day.channels.map((c) => (
                <li
                  key={c.id}
                  className="flex h-12 items-center gap-3 border-b border-border/50 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {c.name ?? c.id}
                  </span>
                  <Sparkline
                    values={c.today}
                    reference={c.d1}
                    className="h-6 w-24 shrink-0"
                  />
                  <span className="tnum w-12 shrink-0 text-right text-sm text-foreground">
                    {formatCount(c.soFar)}
                  </span>
                  <span className="w-28 shrink-0 text-right">
                    <Trend
                      change={relativeChange(c.soFar, c.d1SoFar)}
                      better="up"
                      reference=""
                    />
                  </span>
                </li>
              ))}
            </ul>
          </MetricCard>
        )}
        <MetricCard title={t("monitor.store.cancelsPerHour")}>
          <HourlyChart
            points={cancelPoints}
            pushes={pins}
            label={t("monitor.store.cancelsPerHour")}
          />
        </MetricCard>
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {ORDER_MONITOR_RULES.map((rule) => {
          const verdict = day.verdicts[rule];
          return (
            <MetricCard
              key={rule}
              title={ruleLabel(rule, t)}
              aside={<MonitorStatusMark status={verdict.status} />}
              caption={
                <span className="text-meta tnum">
                  {t("monitor.store.verdict", {
                    observed: verdict.observed,
                    expected: Math.round(verdict.expected),
                  })}
                </span>
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function LiveBody({
  orgSlug,
  connectionId,
  at,
  scopeId,
}: {
  orgSlug: string;
  connectionId: string;
  at: string | undefined;
  scopeId: string | null;
}) {
  const t = useT();
  const day = useOrderMonitorDay(orgSlug, connectionId, at);
  const pushes = useOrderMonitorPushes(
    orgSlug,
    connectionId,
    at,
    scopeId ?? undefined,
  );
  if (day.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }
  if (!day.data) {
    return (
      <EmptyState
        title={t("orderMonitor.dayErrorTitle")}
        description={day.error?.message ?? t("orderMonitor.dayErrorBody")}
      />
    );
  }
  return <Body day={day.data} pushes={pushes.data} />;
}

export function StoreDay({
  store,
  storeId,
  orgSlug,
  scopeId,
  at,
  monitorLink,
  onBackToNow,
}: {
  store: MonitoredStore | undefined;
  storeId: string;
  orgSlug: string;
  scopeId: string | null;
  at: string | undefined;
  /** The Monitor itself, the breadcrumb segment above the store. */
  monitorLink: LinkOptions;
  onBackToNow: () => void;
}) {
  const t = useT();
  return (
    <>
      <Page.Breadcrumbs
        after="page"
        parent={{ link: monitorLink }}
        items={[{ key: "monitor-store", label: store?.store.title ?? storeId }]}
      />
      {at && (
        <Panel.Toolbar.Right.Portal>
          <Button variant="outline" size="sm" onClick={onBackToNow}>
            {t("orderMonitor.backToNow")}
          </Button>
        </Panel.Toolbar.Right.Portal>
      )}
      <LiveBody
        orgSlug={orgSlug}
        connectionId={storeId}
        at={at}
        scopeId={scopeId}
      />
    </>
  );
}

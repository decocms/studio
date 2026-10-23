/**
 * Orders by sales channel, the order monitor's split: today's channels stacked
 * into one area on the day's axis (each hour at its middle), so the shape is
 * the day's orders and the bands are who brought them, with all channels
 * yesterday as one dashed line over it; and a chip per channel with its orders
 * so far against yesterday at this time. Six lines crossing told less.
 */

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import type { OrderMonitorChannel } from "@decocms/shared/order-monitor";
import { useT } from "@/i18n/use-t.ts";
import {
  formatCount,
  relativeChange,
} from "@/layouts/main-panel-tabs/monitor-v8";
import { AXIS_TICK, MetricCard } from "@/layouts/task-board/analytics-sections";
import { BUCKET_MINUTES } from "./board";
import {
  bucketTime,
  domainEnd,
  HOUR_TICKS,
  SYNC_ID,
  usePointer,
} from "./metric-chart";
import { Trend } from "./parts";

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-4)",
  "var(--chart-5)",
];
const HOUR = 60 / BUCKET_MINUTES;

export function ChannelsChart({
  channels,
}: {
  channels: readonly OrderMonitorChannel[];
}) {
  const t = useT();
  const pointer = usePointer();
  const color = (i: number) => COLORS[i % COLORS.length] ?? COLORS[0];
  // The board leaves out the hour under way, so every hour in is a full one.
  const hoursIn = Math.max(
    0,
    ...channels.map((c) => c.today.filter((v) => v !== null).length),
  );
  const data = Array.from({ length: 24 }, (_, h) => ({
    bucket: h * HOUR + HOUR / 2,
    ...Object.fromEntries(
      channels.map((c) => [
        `t${c.id}`,
        h < hoursIn ? (c.today[h] ?? null) : null,
      ]),
    ),
    yesterday:
      h < hoursIn ? channels.reduce((n, c) => n + (c.d1[h] ?? 0), 0) : null,
  }));
  const end = domainEnd(Math.max(0, hoursIn * HOUR - 1));
  return (
    <MetricCard title={t("monitor.store.channels")}>
      <div className="flex flex-col gap-3">
        <ul className="flex flex-wrap gap-x-5 gap-y-2">
          {channels.map((c, i) => (
            <li key={c.id} className="flex items-baseline gap-2">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: color(i) }}
              />
              <span className="text-sm text-foreground">{c.name ?? c.id}</span>
              <span className="tnum text-sm text-foreground">
                {formatCount(c.soFar)}
              </span>
              <Trend
                change={relativeChange(c.soFar, c.d1SoFar)}
                better="up"
                reference=""
              />
            </li>
          ))}
        </ul>
        <ChartContainer
          {...pointer.bind}
          role="img"
          aria-label={t("monitor.store.channels")}
          className="h-[150px] w-full md:h-[170px]"
          config={Object.fromEntries(
            channels.map((c, i) => [
              `t${c.id}`,
              { label: c.name ?? c.id, color: color(i) },
            ]),
          )}
        >
          <ComposedChart
            data={data}
            syncId={SYNC_ID}
            syncMethod="value"
            margin={{ left: 0, right: 0, top: 4 }}
          >
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
              width={44}
              tickCount={4}
              allowDecimals={false}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--border)", strokeDasharray: "4 4" }}
              content={({ active, payload, label }) => (
                <ChartTooltipContent
                  active={active && pointer.over}
                  payload={payload}
                  label={label}
                  labelFormatter={(_, items) => {
                    const bucket = items[0]?.payload?.bucket;
                    return typeof bucket === "number"
                      ? bucketTime(bucket)
                      : null;
                  }}
                />
              )}
            />
            {channels.map((c, i) => (
              <Area
                key={`t${c.id}`}
                dataKey={`t${c.id}`}
                type="monotone"
                stackId="today"
                stroke={color(i)}
                strokeWidth={1.5}
                fill={color(i)}
                fillOpacity={0.25}
                dot={false}
                activeDot={{
                  r: 3,
                  stroke: "var(--background)",
                  strokeWidth: 2,
                }}
                isAnimationActive={false}
              />
            ))}
            <Line
              dataKey="yesterday"
              type="monotone"
              stroke="var(--muted-foreground)"
              strokeOpacity={0.6}
              strokeWidth={1.25}
              strokeDasharray="4 4"
              dot={false}
              activeDot={false}
              tooltipType="none"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ChartContainer>
        <span className="text-meta">{t("monitor.channels.caption")}</span>
      </div>
    </MetricCard>
  );
}

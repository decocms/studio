/**
 * One series over time, drawn like the Monitor's Audience chart. One axis per
 * chart: metrics on different scales are switched, never overlaid.
 */

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import { AXIS_TICK } from "@/layouts/task-board/analytics-sections";
import { bucketTick, fmtInt } from "./panels";

export interface Threshold {
  value: number;
  tone: "warning" | "destructive";
}

const NO_THRESHOLDS: ReadonlyArray<Threshold> = [];

export function TrendChart({
  points,
  metric,
  label,
  color = "var(--chart-1)",
  format = fmtInt,
  thresholds = NO_THRESHOLDS,
}: {
  points: ReadonlyArray<Record<string, unknown>>;
  metric: string;
  label: string;
  color?: string;
  format?: (v: number) => string;
  /** Horizontal lines a reader compares the series with, e.g. a vital's bands. */
  thresholds?: ReadonlyArray<Threshold>;
}) {
  const data = points.map((p) => ({
    t: String(p.t ?? ""),
    [metric]: Number(p[metric]) || 0,
  }));
  return (
    <ChartContainer
      config={{ [metric]: { label, color } }}
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
          tickFormatter={bucketTick}
        />
        <YAxis
          orientation="right"
          axisLine={false}
          tickLine={false}
          tick={AXIS_TICK}
          width={52}
          tickCount={4}
          allowDecimals={false}
          tickFormatter={(v: number) => format(v)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(v) => bucketTick(String(v))}
            />
          }
        />
        {thresholds.map((th) => (
          <ReferenceLine
            key={th.value}
            y={th.value}
            stroke={`var(--${th.tone})`}
            strokeDasharray="3 3"
            strokeOpacity={0.7}
            ifOverflow="extendDomain"
          />
        ))}
        <Area
          dataKey={metric}
          type="monotone"
          fill={color}
          fillOpacity={0.15}
          stroke={color}
          strokeWidth={1.5}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

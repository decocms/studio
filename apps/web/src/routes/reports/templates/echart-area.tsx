import { cn } from "@decocms/ui/lib/utils.ts";
import * as echarts from "echarts";
import { DECK, TONE_COLOR, type Tone } from "./tokens";

/**
 * Full-bleed editorial area chart built on echarts. Renders a smooth area with
 * a ribbed fill, a vertical indicator + dot on the highlighted point, and month
 * labels at the axis. The oversized callout number is an HTML overlay
 * positioned from the chart's own pixel geometry so the type stays crisp and
 * tracks the point on resize.
 */

export interface EChartAreaProps {
  points: number[];
  /** Labels distributed evenly across the points (e.g. Mar / Apr / May / Jun). */
  xLabels: string[];
  highlightIndex: number;
  calloutValue: string;
  tone?: Tone;
  /** Optional unit appended to values in the hover tooltip. */
  unit?: string;
  /** Extra y-axis headroom above the max, as a fraction of the span. Raise it
   *  when the highlighted point is the series max so the floating callout
   *  number has room inside the chart (default 0.08 — the deck slides). */
  yHeadroom?: number;
}

/** Compact value for the tooltip, e.g. 60000 → "60K", 248 → "248 ms". */
function formatValue(v: number, unit?: string): string {
  const abs = Math.abs(v);
  let s: string;
  if (abs >= 1_000_000)
    s = `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  else if (abs >= 1_000) s = `${(v / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  else s = String(v);
  return unit ? `${s} ${unit}` : s;
}

/** A small canvas of faint vertical stripes, used as the area fill pattern. */
function stripeCanvas(stroke: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 6;
  c.height = 6;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = stroke;
    ctx.fillRect(0, 0, 6, 6);
    ctx.globalAlpha = 0.28;
    ctx.fillRect(0, 0, 1.5, 6);
  }
  return c;
}

export default function EChartArea({
  points,
  xLabels,
  highlightIndex,
  calloutValue,
  tone = "good",
  unit,
  yHeadroom = 0.08,
}: EChartAreaProps) {
  // Park the oversized number in whichever TOP corner has open sky — the half of
  // the series that sits lower. An uptrend rises to the right, so its empty space
  // is top-left; a downtrend empties top-right. This decouples the label from the
  // data point (the marker line + dot already show WHERE), so the number never
  // lands on top of the curve. Ties (flat series) default to the left.
  const mid = Math.floor(points.length / 2);
  const mean = (a: number[]) =>
    a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  const side: "left" | "right" =
    mean(points.slice(mid)) >= mean(points.slice(0, mid)) ? "left" : "right";

  // Callback ref with cleanup — the React Compiler memoizes it on the captured
  // props, so the chart re-inits only when the data actually changes.
  const mountChart = (el: HTMLDivElement | null) => {
    if (!el) return;

    const stroke = TONE_COLOR[tone];
    const n = points.length;
    const hi = Math.min(Math.max(highlightIndex, 0), n - 1);

    // Spread the few labels evenly across the many points.
    const labelByIndex: Record<number, string> = {};
    xLabels.forEach((label, i) => {
      const idx =
        xLabels.length === 1
          ? 0
          : Math.round((i * (n - 1)) / (xLabels.length - 1));
      labelByIndex[idx] = label;
    });
    // Forward-fill so every point maps to its period for the hover tooltip.
    const filledLabels: string[] = [];
    let last = xLabels[0] ?? "";
    for (let i = 0; i < n; i++) {
      const label = labelByIndex[i];
      if (label) last = label;
      filledLabels[i] = last;
    }

    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;

    const chart = echarts.init(el);
    const option: echarts.EChartsOption = {
      backgroundColor: "transparent",
      animationDuration: 1100,
      animationEasing: "cubicOut",
      tooltip: {
        trigger: "axis",
        backgroundColor: DECK.ink,
        borderWidth: 0,
        padding: [8, 12],
        textStyle: {
          color: DECK.bg,
          fontSize: 12,
          fontFamily: "Switzer, 'Helvetica Neue', Helvetica, Arial, sans-serif",
        },
        axisPointer: {
          type: "line",
          lineStyle: { color: stroke, width: 1, type: [5, 4] },
          label: { show: false },
        },
        formatter: (
          params: echarts.TooltipComponentFormatterCallbackParams,
        ) => {
          const p = Array.isArray(params) ? params[0] : params;
          const i = (p?.dataIndex as number) ?? 0;
          return `<div style="font-weight:500">${filledLabels[i] ?? ""}</div><div style="opacity:.75;margin-top:2px">${formatValue(points[i] ?? 0, unit)}</div>`;
        },
      },
      grid: { left: 0, right: 0, top: 12, bottom: 34, containLabel: false },
      xAxis: {
        type: "category",
        data: points.map((_, i) => String(i)),
        boundaryGap: false,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          interval: 0,
          margin: 14,
          color: DECK.ink,
          fontFamily: "Switzer, 'Helvetica Neue', Helvetica, Arial, sans-serif",
          fontWeight: 500,
          fontSize: 12,
          alignMinLabel: "left",
          alignMaxLabel: "right",
          formatter: (_v: string, i: number) => labelByIndex[i] ?? "",
        },
      },
      yAxis: {
        type: "value",
        show: false,
        min: min - span * 0.12,
        max: max + span * yHeadroom,
      },
      series: [
        {
          type: "line",
          data: points,
          smooth: 0.5,
          // hidden normally; echarts shows the dot at the hovered point
          symbol: "circle",
          symbolSize: 9,
          showSymbol: false,
          itemStyle: { color: stroke },
          emphasis: {
            scale: 1.3,
            itemStyle: { borderColor: DECK.bg, borderWidth: 2 },
          },
          lineStyle: { color: stroke, width: 2.5 },
          areaStyle: {
            color: {
              image: stripeCanvas(stroke),
              repeat: "repeat",
            } as unknown as string,
            origin: "start",
          },
          markLine: {
            symbol: "none",
            silent: true,
            animation: false,
            label: { show: false },
            lineStyle: { color: stroke, width: 1.5, type: "solid" },
            data: [
              [{ coord: [hi, min - span * 0.12] }, { coord: [hi, points[hi]] }],
            ] as never,
          },
          markPoint: {
            silent: true,
            animation: false,
            symbol: "circle",
            symbolSize: 11,
            itemStyle: { color: stroke },
            label: { show: false },
            data: [{ coord: [hi, points[hi]] }] as never,
          },
        },
      ],
    };
    chart.setOption(option);

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.dispose();
    };
  };

  return (
    <div className="relative h-full w-full">
      <div ref={mountChart} className="h-full w-full" />
      {/* Big number pinned to the open top corner — never over the curve. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 flex px-5 pt-3 sm:px-10 sm:pt-6 lg:px-16",
          side === "left" ? "justify-start" : "justify-end",
        )}
      >
        <span
          className="font-light leading-none tracking-[-0.02em] tabular-nums whitespace-nowrap"
          style={{
            color: TONE_COLOR[tone],
            fontSize: "min(clamp(2.75rem,13vw,7.5rem), 13svh)",
          }}
        >
          {calloutValue}
        </span>
      </div>
    </div>
  );
}

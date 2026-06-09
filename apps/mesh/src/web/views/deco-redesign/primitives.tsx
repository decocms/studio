// Small presentational primitives for the redesign mockup. No state, no data.
import { cn } from "@deco/ui/lib/utils.ts";

/** The one teammate's mark — stands in for a per-storefront avatar. */
export function DecoMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground font-semibold leading-none",
        className,
      )}
    >
      d
    </span>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 text-sm font-medium text-muted-foreground">
      {children}
    </h2>
  );
}

/**
 * The metric card chart (Figma 8356-12948): a trend line over a vertical-striped
 * area fill, with a marker line + dot at the latest point. Width-flexible —
 * stretches to its container (square in a grid, wide on its own). `tone` colors
 * everything; `id` makes the SVG pattern/clip ids unique per instance.
 */
export function MetricChart({
  points,
  tone = "good",
  id,
  className,
}: {
  points: number[];
  tone?: "good" | "bad";
  id: string;
  className?: string;
}) {
  const w = 600;
  const h = 100;
  if (points.length === 0) return null;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const stepX = w / Math.max(points.length - 1, 1);
  const toY = (v: number) => h - 3 - ((v - min) / range) * (h - 10);
  const line = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(1)},${toY(p).toFixed(1)}`,
    )
    .join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  const lastX = (points.length - 1) * stepX;
  const lastY = toY(points[points.length - 1] as number);
  const stripeId = `metric-stripe-${id}`;
  const clipId = `metric-clip-${id}`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn(
        "w-full",
        tone === "good" ? "text-success" : "text-destructive",
        className,
      )}
      role="img"
      aria-label="Metric trend"
    >
      <defs>
        <pattern
          id={stripeId}
          width="6"
          height={h}
          patternUnits="userSpaceOnUse"
        >
          <line
            x1="0.5"
            y1="0"
            x2="0.5"
            y2={h}
            stroke="currentColor"
            strokeWidth="1"
            strokeOpacity="0.18"
          />
        </pattern>
        <clipPath id={clipId}>
          <path d={area} />
        </clipPath>
      </defs>
      <rect
        x="0"
        y="0"
        width={w}
        height={h}
        fill={`url(#${stripeId})`}
        clipPath={`url(#${clipId})`}
      />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1={lastX}
        y1="0"
        x2={lastX}
        y2={h}
        stroke="currentColor"
        strokeWidth="1"
        strokeOpacity="0.4"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={lastX}
        cy={lastY}
        r="3.5"
        fill="currentColor"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * The spike graph System Health summons inside a chat tool UI: drawn inline
 * from mock points as a vertical bar chart. `tone` colors the bars; an
 * optional baseline draws a dashed rule across the plot.
 */
export function SpikeGraph({
  points,
  baseline,
  tone = "muted",
}: {
  points: number[];
  baseline?: number;
  tone?: "destructive" | "warning" | "primary" | "muted";
}) {
  const w = 640;
  const h = 160;
  if (points.length === 0) return null;
  const max = Math.max(...points, baseline ?? 0) * 1.1 || 1;
  const toY = (v: number) => h - (v / max) * h;
  const slot = w / points.length;
  const gap = Math.min(slot * 0.25, 6);
  const barW = slot - gap;
  const toneClass =
    tone === "destructive"
      ? "text-destructive"
      : tone === "warning"
        ? "text-warning"
        : tone === "primary"
          ? "text-primary"
          : "text-muted-foreground";
  const baseY = baseline != null ? toY(baseline) : null;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn("h-40 w-full", toneClass)}
      role="img"
      aria-label="Metric over time"
    >
      {points.map((p, i) => {
        const y = toY(p);
        return (
          <rect
            key={i}
            x={(i * slot + gap / 2).toFixed(1)}
            y={y.toFixed(1)}
            width={barW.toFixed(1)}
            height={(h - y).toFixed(1)}
            rx={1.5}
            fill="currentColor"
            fillOpacity={0.85}
          />
        );
      })}
      {baseY != null && (
        <line
          x1={0}
          y1={baseY}
          x2={w}
          y2={baseY}
          className="text-muted-foreground"
          stroke="currentColor"
          strokeOpacity={0.5}
          strokeWidth={1}
          strokeDasharray="5 5"
        />
      )}
    </svg>
  );
}

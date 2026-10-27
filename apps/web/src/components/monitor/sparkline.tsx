/**
 * The shape of a number's day, no axes: the figure next to it says how much,
 * this says whether the line is where it usually is.
 */

import { cn } from "@decocms/ui/lib/utils.ts";

const WIDTH = 100;
const HEIGHT = 32;
const PAD = 2;

export type SparkTone = "neutral" | "good" | "bad" | "warning";

const TONE: Record<SparkTone, string> = {
  neutral: "text-chart-1",
  good: "text-success",
  bad: "text-destructive",
  warning: "text-warning",
};

function points(
  values: readonly (number | null)[],
  max: number,
  length: number,
) {
  const step = WIDTH / Math.max(1, length - 1);
  return values.flatMap((value, index) =>
    value === null
      ? []
      : [
          {
            x: index * step,
            y: HEIGHT - PAD - (value / max) * (HEIGHT - PAD * 2),
          },
        ],
  );
}

const pathOf = (pts: { x: number; y: number }[]) =>
  pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");

export function Sparkline({
  values,
  reference,
  tone = "neutral",
  marker,
  className,
}: {
  values: readonly (number | null)[];
  /** Index of a moment to mark, e.g. when a deploy landed. */
  marker?: number;
  /** Drawn dashed behind, on the same scale. */
  reference?: readonly (number | null)[];
  tone?: SparkTone;
  className?: string;
}) {
  const length = Math.max(values.length, reference?.length ?? 0);
  const max = Math.max(
    1,
    ...values.map((v) => v ?? 0),
    ...(reference ?? []).map((v) => v ?? 0),
  );
  const line = points(values, max, length);
  const last = line.at(-1);
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className={cn("h-8 w-full overflow-visible", TONE[tone], className)}
    >
      {marker !== undefined && (
        <line
          x1={(marker * WIDTH) / Math.max(1, length - 1)}
          x2={(marker * WIDTH) / Math.max(1, length - 1)}
          y1={0}
          y2={HEIGHT}
          className="stroke-foreground/40"
          strokeWidth={1}
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {reference && (
        <path
          d={pathOf(points(reference, max, length))}
          fill="none"
          className="stroke-muted-foreground/40"
          strokeWidth={1}
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {last && (
        <>
          <path
            d={`${pathOf(line)} L${last.x.toFixed(1)} ${HEIGHT} L0 ${HEIGHT} Z`}
            className="fill-current opacity-10"
          />
          <path
            d={pathOf(line)}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
    </svg>
  );
}

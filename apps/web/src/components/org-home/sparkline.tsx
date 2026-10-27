/**
 * A project's delivery rhythm, fourteen days wide and one row tall — not a
 * business metric (see `lib/project-profile.ts`). Renders nothing when the
 * line would be flat at zero.
 */

import { cn } from "@decocms/ui/lib/utils.ts";

const WIDTH = 56;
const HEIGHT = 16;

export function Sparkline({
  series,
  className,
  label,
  height = HEIGHT,
  /** Fill the caller's width and shade under the line, for a chart that is a
   *  card's body rather than a mark at the end of a row. */
  stretch = false,
}: {
  series: readonly number[];
  className?: string;
  label: string;
  height?: number;
  stretch?: boolean;
}) {
  const max = Math.max(...series);
  if (series.length < 2 || max <= 0) return null;

  const width = stretch ? series.length * 8 : WIDTH;
  const stepX = width / (series.length - 1);
  const coords = series.map((value, index) => ({
    x: index * stepX,
    y: height - 1 - (value / max) * (height - 2),
  }));
  const points = coords
    .map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={stretch ? undefined : width}
      height={height}
      role="img"
      aria-label={label}
      preserveAspectRatio={stretch ? "none" : undefined}
      className={cn(
        stretch ? "w-full" : "shrink-0 overflow-visible",
        className,
      )}
    >
      {stretch && (
        <polygon
          points={`0,${height} ${points} ${width},${height}`}
          fill="currentColor"
          opacity={0.12}
        />
      )}
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

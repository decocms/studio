/**
 * A project's delivery rhythm, fourteen days wide and one row tall.
 *
 * Deliberately not a business metric. A project does not declare a goal
 * anywhere in this product, and inventing a field to hold one is the mistake
 * `lib/project-profile.ts` exists to prevent. What a project provably has is a
 * rhythm — and a flat line on a storefront that used to ship every day is a
 * real thing to notice from a list.
 *
 * It renders nothing when the line would be flat at zero: an empty chart is a
 * chart that says "no data" in the most expensive way available.
 */

import { useId } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";

const WIDTH = 56;
const HEIGHT = 16;

export function Sparkline({
  series,
  className,
  label,
  height = HEIGHT,
  /** Fill the caller's width and shade the area under the line — the mock's
   *  runs card, where the chart IS the card's body rather than a mark at the
   *  end of a row. A stretched viewBox is what lets one component be both. */
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

const formatRounded = (value: number) => String(Math.round(value));

/**
 * A rhythm as a filled area against its own scale — the Cloudflare-style
 * dashboard card: gridlines and the value each one marks turn a shape into a
 * measurement instead of a decoration. Text lives in HTML, not the SVG, so
 * the non-uniform stretch that fills the card's width doesn't warp glyphs.
 */
export function RhythmChart({
  series,
  className,
  label,
  height = 64,
  formatValue = formatRounded,
}: {
  series: readonly number[];
  className?: string;
  label: string;
  height?: number;
  formatValue?: (value: number) => string;
}) {
  /** Two of these render side by side on the home, and an SVG gradient is
   *  referenced by a document-wide id — a shared one would make the second
   *  chart paint with the first's fill. */
  const fillId = `rhythm-fill-${useId()}`;
  const max = Math.max(...series, 0);
  if (series.length < 2 || max <= 0) return null;

  const coords = series.map((value, index) => ({
    x: (index / (series.length - 1)) * 100,
    y: 100 - (value / max) * 100,
  }));
  const points = coords
    .map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" ");

  return (
    <div
      className={cn("flex items-stretch gap-2.5", className)}
      style={{ height }}
    >
      <div className="relative min-w-0 flex-1">
        <div className="absolute inset-0 flex flex-col justify-between">
          <span className="border-border/70 border-t border-dashed" />
          <span className="border-border/50 border-t border-dashed" />
          <span className="border-border border-t" />
        </div>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
          className="absolute inset-0 h-full w-full text-foreground"
        >
          <defs>
            {/* The area fades out downward rather than sitting as one flat
                tint. A solid block of 12% ink reads as a grey shape the eye
                has to look past; a fade reads as the line's own weight. */}
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.16} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
          <polygon
            points={`0,100 ${points} 100,100`}
            fill={`url(#${fillId})`}
          />
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <div className="text-meta flex w-9 shrink-0 flex-col justify-between py-px text-right">
        <span>{formatValue(max)}</span>
        <span>{formatValue(max / 2)}</span>
        <span>0</span>
      </div>
    </div>
  );
}

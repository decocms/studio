/**
 * The miniature report page used as decoration wherever the diagnostic is
 * offered: bleeding out of the home banner's clipped edge, and above the
 * Reports empty state's start form. Pure decoration (aria-hidden).
 *
 * `generating` swaps the score ring and chart for shimmering placeholders.
 * Position, size and rotation come from `className` — the caller frames it.
 */
import { cn } from "@decocms/ui/lib/utils.ts";

export function MiniReportPage({
  generating,
  className,
}: {
  generating?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none rounded-xl border border-border bg-background shadow-lg",
        className,
      )}
    >
      <div className="flex h-full flex-col gap-3 p-4">
        {/* page header: score ring + title lines */}
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 32 32" className="size-9 shrink-0 -rotate-90">
            <circle
              cx="16"
              cy="16"
              r="12"
              fill="none"
              strokeWidth="4"
              className="stroke-muted"
            />
            <circle
              cx="16"
              cy="16"
              r="12"
              fill="none"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray="75.4"
              strokeDashoffset={generating ? "75.4" : "22"}
              className={cn(
                "transition-[stroke-dashoffset] duration-1000 ease-out",
                generating ? "stroke-muted" : "stroke-success",
              )}
            />
          </svg>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div
              className={cn(
                "h-1.5 w-full rounded-full bg-muted",
                generating && "animate-pulse",
              )}
            />
            <div
              className={cn(
                "h-1.5 w-2/3 rounded-full bg-muted",
                generating && "animate-pulse",
              )}
            />
          </div>
        </div>
        {/* mini bar chart */}
        <div className="flex h-10 items-end gap-1.5">
          {[7, 10, 5, 9, 6, 8].map((h, i) => (
            <div
              key={`bar-${i}`}
              style={{ height: `${h * 4}px` }}
              className={cn(
                "flex-1 rounded-sm",
                generating
                  ? "animate-pulse bg-muted"
                  : i % 2 === 0
                    ? "bg-success/70"
                    : "bg-success/30",
              )}
            />
          ))}
        </div>
        {/* body lines running past the clipped edge */}
        <div className="flex flex-col gap-1.5">
          {["w-full", "w-5/6", "w-full", "w-2/3", "w-full"].map((w, i) => (
            <div
              key={`line-${i}`}
              className={cn(
                "h-1.5 rounded-full bg-muted",
                w,
                generating && "animate-pulse",
              )}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

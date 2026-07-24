import { cn } from "@deco/ui/lib/utils.ts";
import SlideHeader from "./slide-header";
import { DECK } from "./tokens";
import type { GaugesProps } from "@decocms/shared/reports/deck-types";

// Core-Web-Vitals-style status → default marker position within the good→poor
// track (used only when a gauge omits an explicit `ratio`).
const STATUS = {
  good: { ratio: 0.16 },
  warn: { ratio: 0.5 },
  bad: { ratio: 0.84 },
} as const;

// The three equal zones of every track, left→right: good / needs-work / poor.
const ZONE_COLOR = [DECK.soft, DECK.warn, "#d43d3d"] as const;
const ZONE_TINT = [
  "rgba(140,170,37,0.16)",
  "rgba(240,182,19,0.16)",
  "rgba(212,61,61,0.14)",
] as const;

// The number + marker take the colour of the zone the marker actually sits in,
// so the value colour always tracks the circle's position (equal thirds).
const zoneIndex = (pos: number) => (pos < 1 / 3 ? 0 : pos < 2 / 3 ? 1 : 2);

/**
 * Several metrics measured against good/needs-work/poor bands, each a segmented
 * track with the value marked in place — the honest read of Core Web Vitals (or
 * any small set of threshold metrics), replacing decorative bars behind numbers.
 */
export default function GaugesTemplate({
  eyebrow,
  headline,
  annotation,
  gauges,
  active,
}: GaugesProps) {
  // Sizing below was tuned for 2-4 CWV-style metrics; the "Notas por área"
  // rollup ships up to 6 gauges, which overflows the slide on BOTH viewports.
  // 5+ gauges compress typography and gaps so every row stays on screen.
  const dense = gauges.length >= 5;
  return (
    <div className="flex h-full flex-col">
      <SlideHeader
        eyebrow={eyebrow}
        headline={headline}
        annotation={annotation}
        active={active}
      />

      {/* vh-based gaps/sizes compress the rows on short viewports so the slide
          never needs its own scroll; overflow-y-auto stays as a last resort. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-[min(1.5rem,2.2svh)] sm:px-10 sm:py-6 lg:px-16">
        <div
          className={cn(
            "my-auto flex w-full flex-col",
            dense
              ? "gap-[min(0.875rem,1.8svh)] sm:gap-5"
              : "gap-[min(1.25rem,2.6svh)] sm:gap-10",
          )}
        >
          {gauges.map((g, i) => {
            const pos = Math.min(
              1,
              Math.max(0, g.ratio ?? STATUS[g.status].ratio),
            );
            const zoneColor = ZONE_COLOR[zoneIndex(pos)];
            return (
              <div
                key={i}
                className={cn(
                  "reveal grid grid-cols-1 items-center gap-x-8 sm:grid-cols-[minmax(0,10rem)_1fr]",
                  dense
                    ? "gap-y-[min(0.5rem,1svh)] sm:gap-y-1.5"
                    : "gap-y-[min(0.75rem,1.4svh)] sm:gap-y-3",
                )}
                data-show={active ? "true" : "false"}
                style={{ transitionDelay: active ? `${80 + i * 90}ms` : "0ms" }}
              >
                {/* value + label — inline on mobile (one line per metric so
                    3-4 gauges fit the slide without scrolling), stacked on sm+ */}
                <div className="flex items-baseline gap-2 sm:flex-col sm:gap-0.5">
                  <span
                    className={cn(
                      "font-light leading-none tracking-[-0.02em] tabular-nums",
                      dense
                        ? "text-[min(clamp(1.5rem,4vw,2rem),3svh)] sm:text-[clamp(1.5rem,2.5vw,2rem)]"
                        : "text-[min(clamp(2rem,5vw,3rem),4svh)] sm:text-[clamp(2rem,5vw,3rem)]",
                    )}
                    style={{ color: zoneColor }}
                  >
                    {g.value}
                  </span>
                  <span
                    className={cn(
                      "tracking-[-0.01em]",
                      dense ? "text-sm sm:text-base" : "text-base sm:text-lg",
                    )}
                    style={{ color: DECK.muted }}
                  >
                    {g.label}
                  </span>
                </div>

                {/* segmented track with the value marker */}
                <div className="flex flex-col gap-1.5">
                  <div className="relative flex h-3 w-full gap-1">
                    {ZONE_TINT.map((tint, zi) => (
                      <span
                        key={zi}
                        className="h-full flex-1 rounded-full"
                        style={{ background: tint }}
                      />
                    ))}
                    {/* marker */}
                    <span
                      className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                      style={{
                        left: `${pos * 100}%`,
                        background: zoneColor,
                        border: `3px solid ${DECK.bg}`,
                        boxShadow: "0 1px 3px rgba(40,37,36,0.25)",
                      }}
                    />
                  </div>
                  {g.caption && (
                    <span
                      className="text-right text-xs sm:text-left sm:text-sm"
                      style={{ color: DECK.muted, opacity: 0.8 }}
                    >
                      {g.caption}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

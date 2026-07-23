import { cn } from "@deco/ui/lib/utils.ts";
import SlideHeader from "./slide-header";
import { DECK, TONE_COLOR } from "./tokens";
import type { BarsProps } from "@decocms/shared/reports/deck-types";

// Segment count of the meter — the lp2 hero meter motif (thin rounded ticks).
const SEGMENTS = 18;

/**
 * Compares a few values as segmented HORIZONTAL meters — each row is label +
 * value over a row of thin ticks filled to `ratio` (the original landing meter
 * motif). Horizontal so it stacks and fits ANY viewport width and any number
 * of items: this is the general "compare a handful of numbers" fallback.
 * Specific shapes (Core Web Vitals → `gauges`) get their own template.
 */
export default function BarsTemplate({
  eyebrow,
  headline,
  annotation,
  items,
  active,
}: BarsProps) {
  // Sizing below was tuned for 2-4 comparison bars; the GEO-dimensions rollup
  // ships up to 9. 5+ rows compress gaps/track/value, and labels wrap to two
  // lines instead of truncating — the "(x/y)" honesty suffix at the end of
  // each rollup label must never be eaten by an ellipsis.
  const dense = items.length >= 5;
  return (
    <div className="flex h-full flex-col">
      <SlideHeader
        eyebrow={eyebrow}
        headline={headline}
        annotation={annotation}
        active={active}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-[min(1.5rem,2svh)] sm:px-10 sm:py-6 lg:px-16">
        <div
          className={cn(
            "my-auto flex w-full flex-col",
            dense
              ? "gap-[min(1rem,1.9svh)] sm:gap-4"
              : "gap-[min(1.625rem,2.8svh)] sm:gap-9",
          )}
        >
          {items.map((it, i) => {
            const color = TONE_COLOR[it.tone ?? "neutral"];
            // Even near-zero ratios show one lit tick so every meter reads as
            // present, not missing (e.g. the typo query at 0.75%).
            const filled = Math.max(
              1,
              Math.min(SEGMENTS, Math.round(it.ratio * SEGMENTS)),
            );
            return (
              <div
                key={i}
                className={cn(
                  "reveal flex flex-col",
                  dense ? "gap-1.5" : "gap-2 sm:gap-2.5",
                )}
                data-show={active ? "true" : "false"}
                style={{ transitionDelay: active ? `${80 + i * 90}ms` : "0ms" }}
              >
                <div className="flex items-baseline justify-between gap-4">
                  <span
                    className={cn(
                      "min-w-0 flex-1 tracking-[-0.01em]",
                      dense
                        ? "line-clamp-2 break-words text-sm leading-snug sm:text-base"
                        : "truncate text-sm sm:text-base",
                    )}
                    style={{ color: DECK.muted }}
                  >
                    {it.label}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 font-light leading-none tracking-[-0.02em] tabular-nums",
                      dense
                        ? "text-[min(clamp(1.375rem,3.5vw,1.75rem),3svh)]"
                        : "text-[min(clamp(1.5rem,4.5vw,2.5rem),3.4svh)] sm:text-[clamp(1.5rem,3vw,2.5rem)]",
                    )}
                    style={{ color }}
                  >
                    {it.value}
                  </span>
                </div>
                {/* the ticks light up left→right after the row reveals */}
                <div className="flex gap-[3px]">
                  {Array.from({ length: SEGMENTS }, (_, s) => (
                    <span
                      key={s}
                      className={cn(
                        "flex-1 rounded-[2px]",
                        dense ? "h-2.5 sm:h-3" : "h-3 sm:h-3.5",
                      )}
                      style={{
                        background:
                          active && s < filled ? color : "rgba(40,37,36,0.08)",
                        transition: "background-color 240ms ease",
                        transitionDelay:
                          active && s < filled
                            ? `${180 + i * 90 + s * 24}ms`
                            : "0ms",
                      }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

import { cn } from "@decocms/ui/lib/utils.ts";
import SlideHeader from "./slide-header";
import { DECK, TONE_COLOR } from "./tokens";
import type { StatsProps } from "@decocms/shared/reports/deck-types";

/**
 * A grid of headline metrics — each a big value + label, tone-coloured. Chosen
 * when several single numbers tell the story together (page weight, requests,
 * JS bundle…).
 *
 * Each metric lives in a bordered surface tile that STRETCHES to fill the slide
 * (auto-rows-fr + h-full), so a couple of numbers never float in a sea of cream
 * — the old failure mode. Reserve this for genuinely numeric metrics; pass/fail
 * findings belong in `checklist`.
 */
export default function StatsTemplate({
  eyebrow,
  headline,
  annotation,
  stats,
  active,
}: StatsProps) {
  // Column count tuned so tiles stay comfortably sized: 1–2 stack full-width,
  // 3 go in a row on desktop, 4+ tile 2-up.
  const cols =
    stats.length <= 2
      ? "grid-cols-1"
      : stats.length === 3
        ? "grid-cols-1 sm:grid-cols-3"
        : "grid-cols-2";

  return (
    <div className="flex h-full flex-col">
      <SlideHeader
        eyebrow={eyebrow}
        headline={headline}
        annotation={annotation}
        active={active}
      />

      <div className="flex min-h-0 flex-1 flex-col px-5 pb-2 pt-6 sm:px-10 sm:pt-8 lg:px-16">
        {/* Mobile: rows hug their content and the block centres in the track —
            stretched tiles read as empty air on a tall phone. Desktop keeps the
            full-bleed stretch (auto-rows-fr) so numbers never float in cream. */}
        <div
          className={cn(
            "my-auto grid gap-3 sm:my-0 sm:h-full sm:auto-rows-fr sm:gap-4",
            cols,
          )}
        >
          {stats.map((s, i) => {
            // Values are usually short numbers, but the model sometimes emits a
            // text value ("Ausente", "Não detectado") — scale the type down and
            // allow wrapping so a long value never overflows its tile.
            const v = String(s.value ?? "");
            const size =
              v.length <= 5
                ? "text-[min(clamp(2rem,6vw,4rem),5svh)] sm:text-[clamp(2.25rem,6vw,4rem)]"
                : v.length <= 9
                  ? "text-[min(clamp(1.5rem,4.5vw,2.75rem),4svh)] sm:text-[clamp(1.75rem,4.5vw,2.75rem)]"
                  : "text-[min(clamp(1.125rem,3.5vw,1.875rem),3svh)] sm:text-[clamp(1.25rem,3.5vw,1.875rem)]";
            return (
              <div
                key={i}
                className="reveal flex min-w-0 flex-col justify-center gap-2 rounded-xl border px-5 py-[min(1.25rem,2svh)] sm:px-8 sm:py-6"
                data-show={active ? "true" : "false"}
                style={{
                  background: DECK.surface,
                  borderColor: DECK.cardBorder,
                  transitionDelay: active ? `${60 + i * 70}ms` : "0ms",
                }}
              >
                <span
                  className={cn(
                    "break-words font-light leading-[1.05] tracking-[-0.02em] tabular-nums",
                    size,
                  )}
                  style={{ color: TONE_COLOR[s.tone ?? "neutral"] }}
                >
                  {v}
                </span>
                <span
                  className="break-words text-sm tracking-[-0.015em] sm:text-base"
                  style={{ color: DECK.muted }}
                >
                  {s.label}
                </span>
                {s.sub && (
                  <span
                    className="break-words text-sm"
                    style={{ color: DECK.muted, opacity: 0.7 }}
                  >
                    {s.sub}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

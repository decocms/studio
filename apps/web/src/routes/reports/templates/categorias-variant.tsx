import type { TranslationKey } from "@/i18n/en/index.ts";
import { useT } from "@/i18n/use-t.ts";
import SlideHeader from "./slide-header";
import { DECK } from "./tokens";
import type { GaugesProps } from "@decocms/shared/reports/deck-types";

// Zone system shared with GaugesTemplate: good ≥75 · warn ≥50 · bad <50.
const ZONE = {
  good: { color: "#009a41", tint: "rgba(0,154,65,0.14)" },
  warn: { color: "#d98324", tint: "rgba(217,131,36,0.14)" },
  bad: { color: "#ef4444", tint: "rgba(239,68,68,0.14)" },
} as const;

const BAND_LABEL: Record<
  GaugesProps["gauges"][number]["status"],
  TranslationKey
> = {
  good: "reports.categoriasVariant.bandGood",
  warn: "reports.categoriasVariant.bandWeak",
  bad: "reports.categoriasVariant.bandCritical",
};

// Ring geometry — one source of truth for the sweep math.
const R = 33;
const CIRC = 2 * Math.PI * R;

/** How many checks fed a gauge, pulled out of the engine's caption
 *  ("Crítico (16 verificações)" → 16). Anchored to the parenthesis so a band
 *  word containing a digit can't be read as the count. The band word itself is
 *  ignored — `status` already carries it, typed and translatable. Null when the
 *  caption carries no number, which just hides the line. */
export function checkCount(caption?: string): number | null {
  const digits = caption?.match(/\((\d+)/)?.[1];
  return digits ? Number(digits) : null;
}

/**
 * Keyed variant for the engine's deterministic per-area score slide (up to 6
 * category scores). The generic gauges rows read flat at this volume; here each
 * area becomes a report-card cell with an animated score ring — same data,
 * no contract change (see registry.tsx).
 *
 * The slide's chrome (eyebrow / headline / annotation) is written here rather
 * than taken from the deck: the engine emits one constant string for this slide
 * for every store, in Portuguese, whatever `lang` the reader asked for. That's
 * chrome, not a finding — so it belongs with the rest of the deck's chrome, in
 * the dictionaries. If the engine ever starts writing this per store, take its
 * copy back and delete the overrides.
 */
export default function CategoriasVariant({
  gauges,
  active,
}: Pick<GaugesProps, "gauges" | "active">) {
  const t = useT();
  const eyebrow = t("reports.categoriasVariant.eyebrow");
  const headline = t("reports.categoriasVariant.headline");
  const annotation = t("reports.categoriasVariant.annotation");

  return (
    <div className="flex h-full flex-col">
      <SlideHeader
        eyebrow={eyebrow}
        headline={headline}
        annotation={annotation}
        active={active}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-[min(1rem,1.8svh)] sm:px-10 sm:py-4 lg:px-16">
        <div className="my-auto grid w-full grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-4">
          {gauges.map((g, i) => {
            const zone = ZONE[g.status];
            const score = Math.min(1, Math.max(0, g.ratio ?? 0));
            const count = checkCount(g.caption);
            return (
              <div
                key={i}
                className="reveal flex flex-col items-center rounded-2xl px-2 py-[min(0.875rem,1.6svh)] text-center sm:px-4 sm:py-5"
                data-show={active ? "true" : "false"}
                style={{
                  background: DECK.surface,
                  border: `1px solid ${DECK.border}`,
                  transitionDelay: active ? `${100 + i * 80}ms` : "0ms",
                }}
              >
                {/* score ring — sweeps from empty to the score on entrance */}
                <div className="relative h-[min(4.25rem,9svh)] w-[min(4.25rem,9svh)] sm:h-20 sm:w-20">
                  <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
                    <circle
                      cx="40"
                      cy="40"
                      r={R}
                      fill="none"
                      stroke={zone.tint}
                      strokeWidth="7"
                    />
                    <circle
                      cx="40"
                      cy="40"
                      r={R}
                      fill="none"
                      stroke={zone.color}
                      strokeWidth="7"
                      strokeLinecap="round"
                      strokeDasharray={CIRC}
                      strokeDashoffset={active ? CIRC * (1 - score) : CIRC}
                      className="transition-[stroke-dashoffset] duration-1000 ease-out"
                      style={{
                        transitionDelay: active ? `${200 + i * 80}ms` : "0ms",
                      }}
                    />
                  </svg>
                  <span
                    className="absolute inset-0 flex items-center justify-center font-semibold leading-none tracking-[-0.02em] tabular-nums text-[min(1.375rem,3svh)] sm:text-2xl"
                    style={{ color: zone.color }}
                  >
                    {g.value}
                  </span>
                </div>

                <span
                  className="mt-[min(0.5rem,1svh)] line-clamp-2 text-[13px] font-medium leading-tight sm:mt-2.5 sm:text-sm"
                  style={{ color: DECK.ink }}
                >
                  {g.label}
                </span>

                <span
                  className="mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium leading-[1.4] sm:text-[11px]"
                  style={{ color: zone.color, background: zone.tint }}
                >
                  {t(BAND_LABEL[g.status])}
                </span>

                {count !== null && (
                  <span
                    className="mt-1 hidden text-[11px] sm:block"
                    style={{ color: DECK.muted, opacity: 0.8 }}
                  >
                    {t(
                      count === 1
                        ? "reports.categoriasVariant.checkOne"
                        : "reports.categoriasVariant.checkMany",
                      { count },
                    )}
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

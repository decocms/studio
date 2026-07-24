import SlideHeader from "./slide-header";
import { DECK } from "./tokens";
import type { ThresholdProps } from "@decocms/shared/reports/deck-types";

// CrUX-style bands: good (≤ threshold) / needs-work / poor. The bar reads
// green→amber→red left to right; the segment covered by the measured value is
// saturated, the rest shows the band's faint tint.
const BAND = {
  good: { solid: DECK.soft, tint: "rgba(140,170,37,0.16)" },
  warn: { solid: DECK.warn, tint: "rgba(240,182,19,0.16)" },
  poor: { solid: "#d43d3d", tint: "rgba(212,61,61,0.14)" },
} as const;

/**
 * One metric vs a "good" threshold, drawn as a single tall bar (Core-Web-Vitals
 * style): a big value coloured by the band it falls in, then one continuous
 * rounded bar split into green (≤ good) / amber (needs-work) / red (poor) zones —
 * each zone filled saturated up to the measured value and faint beyond it — with
 * a marker line + label sitting on the "good" threshold. Assumes lower-is-better
 * (the "good ≤ X" pattern). Mobile-first.
 */
export default function ThresholdTemplate({
  eyebrow,
  headline,
  annotation,
  value,
  metricLabel,
  ratio,
  thresholdRatio,
  thresholdLabel,
  active,
}: ThresholdProps) {
  // good/needs boundary = the "good ≤" line; needs/poor boundary derived from it
  // (CrUX poor band is roughly the same width again beyond "good").
  const goodMax = thresholdRatio ?? Math.min(ratio, 0.45);
  const poorMax = Math.min(0.94, goodMax + (1 - goodMax) * 0.55);
  const markerPct = goodMax * 100;

  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const valueColor = (
    ratio < goodMax ? BAND.good : ratio < poorMax ? BAND.warn : BAND.poor
  ).solid;

  // The three zones, left→right. Each fills saturated from its own start up to
  // the measured value, then falls back to the tint for the rest of the zone.
  const zones = [
    { start: 0, end: goodMax, band: BAND.good },
    { start: goodMax, end: poorMax, band: BAND.warn },
    { start: poorMax, end: 1, band: BAND.poor },
  ].map((z) => ({
    ...z,
    fill:
      z.end > z.start
        ? clamp((Math.min(ratio, z.end) - z.start) / (z.end - z.start))
        : 0,
  }));

  return (
    <div className="flex h-full flex-col">
      <SlideHeader
        eyebrow={eyebrow}
        headline={headline}
        annotation={annotation}
        active={active}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6 sm:px-10 lg:px-16">
        <div className="my-auto flex w-full flex-col gap-8 sm:gap-10">
          {/* big value — coloured by the band it lands in */}
          <div
            className="reveal flex flex-col gap-1"
            data-show={active ? "true" : "false"}
            style={{ transitionDelay: active ? "80ms" : "0ms" }}
          >
            <span
              className="font-light leading-none tracking-[-0.02em] tabular-nums text-[min(clamp(2.5rem,11vw,7rem),9svh)] sm:text-[clamp(3.5rem,12vw,7rem)]"
              style={{ color: valueColor }}
            >
              {value}
            </span>
            {metricLabel && (
              <span
                className="text-base tracking-[-0.015em] sm:text-xl"
                style={{ color: DECK.muted }}
              >
                {metricLabel}
              </span>
            )}
          </div>

          {/* continuous banded bar + threshold marker */}
          <div
            className="reveal relative w-full"
            data-show={active ? "true" : "false"}
            style={{ transitionDelay: active ? "180ms" : "0ms" }}
          >
            <div className="relative h-11 w-full overflow-hidden rounded-2xl sm:h-14">
              {zones.map((z, i) => (
                <div
                  key={i}
                  className="absolute inset-y-0"
                  style={{
                    left: `${z.start * 100}%`,
                    width: `${(z.end - z.start) * 100}%`,
                    background: z.band.tint,
                  }}
                >
                  <div
                    className="h-full transition-[width] duration-700 ease-out"
                    style={{
                      width: active ? `${z.fill * 100}%` : "0%",
                      background: z.band.solid,
                    }}
                  />
                </div>
              ))}
              {/* threshold marker line, sitting on the "good" boundary */}
              <div
                className="absolute inset-y-0 w-px -translate-x-1/2"
                style={{ left: `${markerPct}%`, background: DECK.ink }}
              />
            </div>
            <span
              className="absolute -translate-x-1/2 whitespace-nowrap text-sm tracking-[-0.015em] opacity-60 sm:text-base"
              style={{
                left: `${markerPct}%`,
                top: "100%",
                marginTop: 10,
                color: DECK.muted,
              }}
            >
              {thresholdLabel}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

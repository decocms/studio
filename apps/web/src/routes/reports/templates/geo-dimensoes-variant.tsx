import SlideHeader from "./slide-header";
import { DECK } from "./tokens";
import { useT } from "@/i18n/use-t.ts";
import type { BarsProps, Tone } from "@decocms/shared/reports/deck-types";

// Same good/warn/bad zone palette used elsewhere for score rings. The generic
// TONE_COLOR maps `neutral` to near-black ink, which reads as a dead bar
// between red and green on a 7-row board — here the middle band is amber,
// like everywhere else the deck grades a score.
const TONE_ZONE: Record<Tone, { color: string; tint: string }> = {
  good: { color: "#009a41", tint: "rgba(0,154,65,0.14)" },
  neutral: { color: "#d98324", tint: "rgba(217,131,36,0.14)" },
  bad: { color: "#ef4444", tint: "rgba(239,68,68,0.14)" },
};

const MIN_PCT = 2;

/** "Dados estruturados (2/2)" → { name, measured: "2", total: "2" }. The chip is
 *  worded by the caller (it needs the viewer's locale). Falls back to the raw
 *  label (no counts) when the engine's suffix shape surprises. */
function splitLabel(label: string): {
  name: string;
  measured?: string;
  total?: string;
} {
  const m = label.match(/^(.*?)\s*\((\d+)\/(\d+)\)$/);
  if (m) return { name: m[1] ?? "", measured: m[2], total: m[3] };
  return { name: label };
}

/**
 * Keyed variant for the engine's deterministic "Prontidão para busca por IA"
 * slide (up to 9 GEO dimensions). Rows are ranked worst-first — the slide opens
 * on where AI search is losing the store — with zone-tinted tracks and the
 * measured-count honesty as a proper chip instead of a parenthesis that used to
 * be the first thing truncation ate. Same data, no contract change.
 */
export default function GeoDimensoesVariant({
  eyebrow,
  headline,
  annotation,
  items,
  active,
}: BarsProps) {
  const t = useT();
  const ranked = [...items].sort(
    (a, b) => (Number(a.value) || 0) - (Number(b.value) || 0),
  );
  return (
    <div className="flex h-full flex-col">
      <SlideHeader
        eyebrow={eyebrow}
        headline={headline}
        annotation={annotation}
        active={active}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 sm:px-10 lg:px-16">
        <div className="my-auto flex w-full flex-col gap-[min(0.875rem,1.7svh)] sm:gap-4">
          {ranked.map((it, i) => {
            const zone = TONE_ZONE[it.tone ?? "neutral"];
            const pct = Math.max(MIN_PCT, Math.min(100, it.ratio * 100));
            const { name, measured, total } = splitLabel(it.label);
            const chip =
              measured && total
                ? t("reports.geoDimensionsVariant.chip", { measured, total })
                : undefined;
            return (
              <div
                key={i}
                className="reveal flex flex-col gap-1.5"
                data-show={active ? "true" : "false"}
                style={{ transitionDelay: active ? `${80 + i * 70}ms` : "0ms" }}
              >
                <div className="flex items-baseline gap-2.5">
                  <span
                    className="min-w-0 line-clamp-2 break-words text-sm font-medium leading-snug tracking-[-0.01em] sm:text-[15px]"
                    style={{ color: DECK.ink }}
                  >
                    {name}
                  </span>
                  {chip && (
                    <span
                      className="shrink-0 translate-y-[-1px] rounded-full px-1.5 py-px text-[10px] leading-[1.5]"
                      style={{
                        color: DECK.muted,
                        border: `1px solid ${DECK.border}`,
                      }}
                    >
                      {chip}
                    </span>
                  )}
                  <span
                    className="ml-auto shrink-0 font-semibold leading-none tracking-[-0.02em] tabular-nums text-[min(1.5rem,3svh)] sm:text-[1.625rem]"
                    style={{ color: zone.color }}
                  >
                    {it.value}
                  </span>
                </div>
                <div
                  className="h-[min(0.75rem,1.4svh)] w-full overflow-hidden rounded-full sm:h-3"
                  style={{ background: zone.tint }}
                >
                  <div
                    className="h-full rounded-full transition-[width] duration-700 ease-out"
                    style={{
                      width: active ? `${pct}%` : "0%",
                      background: zone.color,
                      transitionDelay: active ? `${150 + i * 70}ms` : "0ms",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

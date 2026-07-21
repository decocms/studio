import SlideHeader from "./slide-header";
import { DECK, TONE_COLOR } from "./tokens";
import { useT } from "@/web/i18n/use-t.ts";
import type { KeywordsProps } from "@/reports/deck-types";

// Rank → colour. Top-3 is the prize (green); 4–10 is "close but losing clicks"
// (DECK.warn); anything lower or unranked is a miss (red). Mirrors the "you
// don't rank top-3" narrative this slide carries.
function rankColor(p: number): string {
  if (!p || p <= 0) return TONE_COLOR.bad;
  if (p <= 3) return TONE_COLOR.good;
  if (p <= 10) return DECK.warn;
  return TONE_COLOR.bad;
}
function rankLabel(p: number): string {
  return p && p > 0 ? `${p}ª` : "—";
}

/**
 * A compact ranked table of the store's organic keywords: term · monthly search
 * volume · current SERP position (tone-coloured). Bounded and centred so it never
 * scrolls. Replaces the old two-big-"4ª posição" stat layout for keyword slides.
 */
export default function KeywordsTemplate({
  eyebrow,
  headline,
  annotation,
  keywords,
  volumeLabel,
  active,
}: KeywordsProps) {
  const t = useT();
  const rows = keywords.slice(0, 8);
  return (
    <div className="flex h-full flex-col">
      <SlideHeader
        eyebrow={eyebrow}
        headline={headline}
        annotation={annotation}
        active={active}
      />

      {/* Centres when there's room; when the description is long it scrolls
          instead of overlapping the header (my-auto degrades to top-aligned). */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-[min(1rem,1.4svh)] sm:px-10 sm:py-4 lg:px-16">
        <div className="my-auto w-full">
          {/* column header */}
          <div
            className="flex items-center gap-2 px-1 pb-1 text-[10px] font-medium uppercase tracking-[0.04em] sm:gap-3 sm:px-3 sm:text-[11px]"
            style={{ color: DECK.muted }}
          >
            <span className="min-w-0 flex-1 truncate">
              {t("reports.keywordsTemplate.keyword")}
            </span>
            <span className="w-20 shrink-0 text-right sm:w-24">
              {volumeLabel ?? t("reports.keywordsTemplate.searchesPerMonth")}
            </span>
            <span className="w-12 shrink-0 text-right sm:w-16">
              {t("reports.keywordsTemplate.position")}
            </span>
          </div>

          <ul className="flex flex-col">
            {rows.map((k, i) => (
              <li
                key={i}
                className="reveal flex items-center gap-2 px-1 py-[min(10px,1.1svh)] sm:gap-3 sm:px-3 sm:py-[10px]"
                data-show={active ? "true" : "false"}
                style={{
                  ...(i < rows.length - 1
                    ? { borderBottom: `1px solid ${DECK.border}` }
                    : {}),
                  transitionDelay: active ? `${70 + i * 55}ms` : "0ms",
                }}
              >
                <span
                  className="min-w-0 flex-1 truncate text-base sm:text-lg"
                  style={{ color: DECK.ink }}
                >
                  {k.term}
                </span>
                <span
                  className="w-20 shrink-0 text-right text-sm tabular-nums sm:w-24 sm:text-base"
                  style={{ color: DECK.muted }}
                >
                  {k.volume}
                </span>
                <span
                  className="w-12 shrink-0 text-right text-lg font-normal tabular-nums tracking-[-0.01em] sm:w-16 sm:text-xl"
                  style={{ color: rankColor(k.position) }}
                >
                  {rankLabel(k.position)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

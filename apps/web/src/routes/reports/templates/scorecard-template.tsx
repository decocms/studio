import { cn } from "@deco/ui/lib/utils.ts";
import { useState } from "react";
import Icon from "../icon";
import SlideHeader from "./slide-header";
import { DECK, TONE_COLOR } from "./tokens";
import { useT } from "@/i18n/use-t.ts";
import type { ScorecardProps } from "@decocms/shared/reports/deck-types";

// Parse a display value ("1,08M", "54,5k", "59,7%", "7.504", "62") into a number
// for the comparison bar. Brazilian formatting: "." = thousands, "," = decimal,
// k/M/B suffixes. Words like "maior"/"menor" have no digits → null.
function parseValue(s?: string): number | null {
  if (!s) return null;
  const m = s.replace(/\s/g, "").match(/^[^\d]*([\d.,]+)\s*([kKmMbB])?/);
  if (!m) return null;
  const n = Number.parseFloat(
    (m[1] ?? "").replace(/\./g, "").replace(",", "."),
  );
  if (Number.isNaN(n)) return null;
  const suf = (m[2] || "").toLowerCase();
  return n * (suf === "b" ? 1e9 : suf === "m" ? 1e6 : suf === "k" ? 1e3 : 1);
}

// rivalName is sometimes a domain (magazineluiza.com.br) and sometimes a brand
// ("Mercado Livre"). Only domains get a favicon; brands fall back to initials.
function isDomain(s?: string): boolean {
  return !!s && !/\s/.test(s) && /\.[a-z]{2,}$/i.test(s.replace(/\/+$/, ""));
}

/** Brand avatar: favicon for a domain, initials chip otherwise. */
function RivalMark({ name, className }: { name?: string; className: string }) {
  const [failed, setFailed] = useState(false);
  const domain = name?.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const initial =
    (name ?? "?")
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")[0]
      ?.toUpperCase() ?? "?";
  const showFavicon = isDomain(name) && !failed;
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-[10px]",
        className,
      )}
      style={{
        background: DECK.surface,
        border: `1px solid ${DECK.border}`,
      }}
    >
      {showFavicon ? (
        <img
          src={`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain ?? "")}`}
          alt=""
          className="h-full w-full object-contain p-1"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="text-xs font-medium" style={{ color: DECK.muted }}>
          {initial}
        </span>
      )}
    </span>
  );
}

/** Display form of the rival label — strip protocol/www from domains. */
function rivalDisplay(name?: string): string {
  if (!name) return "";
  return name
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

// Favicon tile size — vh-capped on mobile so 4+ rows fit short viewports.
// Bumped from 2rem so the rival's brand reads louder on the rows that actually
// have a comparison (Guilherme: "muito mais foco na logo do concorrente").
const FAV_CLS = "h-[min(2.5rem,4svh)] w-[min(2.5rem,4svh)] sm:h-10 sm:w-10";
// Sort key: what you lead first, ties/neutral next, what you're behind on last.
const rank = (t?: string) => (t === "good" ? 0 : t === "bad" ? 2 : 1);

/**
 * Consolidated competitive posture — one flat row per discovery dimension
 * (no cards): your favicon + value on the left, the rival's favicon + value on
 * the right, and a "tug of war" bar between them whose fill shows the split
 * (real proportion when both are numeric, tone-driven otherwise so "maior/menor"
 * rows still read visually). Rows are sorted and grouped into what you lead vs
 * what you're behind on, so the story reads top-to-bottom.
 */
export default function ScorecardTemplate({
  eyebrow,
  headline,
  annotation,
  rivalLabel,
  dimensions,
  faviconUrl,
  active,
}: ScorecardProps) {
  const t = useT();
  const sorted = dimensions
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d.tone) - rank(b.d.tone) || a.i - b.i);

  return (
    <div className="flex h-full flex-col">
      <SlideHeader
        eyebrow={eyebrow}
        headline={headline}
        annotation={annotation}
        active={active}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-[min(1rem,1.2svh)] sm:px-10 sm:py-4 lg:px-16">
        <div className="my-auto flex w-full flex-col">
          {sorted.map(({ d, i }, idx) => {
            // Neutral/"empate" uses a muted grey — never solid ink (a black bar
            // reads as a bug, not a tie).
            const youColor =
              d.tone === "good"
                ? TONE_COLOR.good
                : d.tone === "bad"
                  ? TONE_COLOR.bad
                  : DECK.muted;
            const hasRival = !!(d.rival || d.rivalName);
            const youNum = parseValue(d.you);
            const rivalNum = parseValue(d.rival);
            const bothNum =
              youNum != null && rivalNum != null && youNum + rivalNum > 0;
            // Fill = your share of the row. Real proportion when numeric; else a
            // tone-driven split so qualitative ("maior"/"menor") rows still show.
            const share = bothNum
              ? Math.min(
                  0.9,
                  Math.max(
                    0.1,
                    (youNum as number) /
                      ((youNum as number) + (rivalNum as number)),
                  ),
                )
              : d.tone === "good"
                ? 0.72
                : d.tone === "bad"
                  ? 0.28
                  : 0.5;
            const youLeads = d.tone === "good";
            const rivalLeads = d.tone === "bad";
            const leadColor = youLeads
              ? TONE_COLOR.good
              : rivalLeads
                ? TONE_COLOR.bad
                : DECK.muted;

            return (
              <div
                key={i}
                className="reveal flex flex-col gap-[min(0.5rem,0.9svh)] py-[min(0.75rem,1.1svh)] sm:gap-2 sm:py-3"
                data-show={active ? "true" : "false"}
                style={{
                  borderTop:
                    idx === 0 ? "none" : `1px solid ${DECK.cardBorder}`,
                  transitionDelay: active ? `${80 + idx * 55}ms` : "0ms",
                }}
              >
                {/* label + who leads */}
                <div className="flex items-center justify-between gap-3">
                  <span
                    className="min-w-0 truncate text-sm font-medium sm:text-[15px]"
                    style={{ color: DECK.ink }}
                  >
                    {d.label}
                  </span>
                  <span
                    className="flex shrink-0 items-center gap-1 text-[11px] font-medium sm:text-xs"
                    style={{ color: leadColor }}
                  >
                    {(youLeads || rivalLeads) && (
                      <Icon
                        name={youLeads ? "trending_up" : "trending_down"}
                        size="xs"
                      />
                    )}
                    {youLeads
                      ? t("reports.scorecardTemplate.youLead")
                      : rivalLeads
                        ? t("reports.scorecardTemplate.rivalLeads", {
                            rival:
                              rivalDisplay(d.rivalName) ||
                              rivalLabel ||
                              t("reports.competitorTemplate.competitor"),
                          })
                        : hasRival
                          ? t("reports.scorecardTemplate.tie")
                          : t("reports.scorecardTemplate.noComparison")}
                  </span>
                </div>

                {/* head-to-head: you • bar • rival */}
                <div className="flex items-center gap-2.5 sm:gap-3">
                  <img
                    src={faviconUrl}
                    alt=""
                    width={32}
                    height={32}
                    className={cn(
                      "shrink-0 rounded-[10px] border bg-white p-1",
                      FAV_CLS,
                    )}
                    style={{ borderColor: DECK.border }}
                  />
                  <span
                    className="shrink-0 text-[min(1.125rem,2.5svh)] font-normal tabular-nums tracking-[-0.01em] sm:text-xl"
                    style={{ color: youColor }}
                  >
                    {d.you}
                  </span>

                  <span
                    className="relative h-3.5 flex-1 overflow-hidden rounded-full"
                    style={{ background: "rgba(40,37,36,0.07)" }}
                  >
                    <span
                      className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out"
                      style={{
                        width: active ? `${share * 100}%` : "0%",
                        background: youColor,
                      }}
                    />
                  </span>

                  {hasRival && (
                    <>
                      <span
                        className="shrink-0 text-[min(1.125rem,2.5svh)] tabular-nums sm:text-xl"
                        style={{ color: DECK.muted }}
                      >
                        {d.rival ?? "—"}
                      </span>
                      <RivalMark name={d.rivalName} className={FAV_CLS} />
                    </>
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

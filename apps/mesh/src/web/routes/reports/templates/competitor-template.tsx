import { useState } from "react";
import SlideHeader from "./slide-header";
import { trackConnectCta } from "../onboarding";
import { useReportCtaHref } from "../use-report-cta-href";
import { DECK, TONE_COLOR } from "./tokens";
import type { CompetitorProps } from "@/reports/deck-types";
import { useT } from "@/web/i18n/use-t.ts";

/** A domain-like competitor name → a favicon URL (Google's S2 service resolves
 *  any host; falls back to a globe, which we replace with an initial on error). */
function faviconFor(name: string): string | null {
  const host =
    name
      .trim()
      .replace(/^https?:\/\//, "")
      .split("/")[0] ?? "";
  return /\./.test(host)
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`
    : null;
}

/** A brand tile — favicon when we can resolve one, else the name's initial. */
function BrandTile({
  initial,
  faviconUrl,
}: {
  initial: string;
  faviconUrl: string | null;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-white sm:size-10"
      style={{
        border: `1px solid ${DECK.border}`,
        boxShadow:
          "0 1px 1px rgba(40,37,36,0.04),0 3px 9px rgba(40,37,36,0.04),0 6px 18px rgba(40,37,36,0.02)",
      }}
    >
      {faviconUrl && !failed ? (
        <img
          src={faviconUrl}
          alt=""
          className="h-full w-full object-contain p-2"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="text-lg font-medium" style={{ color: DECK.muted }}>
          {initial}
        </span>
      )}
    </span>
  );
}

/**
 * Ranks the scanned store against named competitors on ONE metric (Figma
 * 8669-27870). Each row: brand tile + name + the metric value, tone-coloured;
 * the "you" row is a highlighted card. Closes with an edit-competitors CTA.
 */
export default function CompetitorTemplate({
  eyebrow,
  headline,
  annotation,
  metricLabel,
  competitors,
  faviconUrl,
  domain,
  active,
}: CompetitorProps) {
  const t = useT();
  const ctaHref = useReportCtaHref(domain);
  return (
    <div className="flex h-full flex-col">
      <SlideHeader
        eyebrow={eyebrow}
        headline={headline}
        annotation={annotation}
        active={active}
      />

      <div className="flex min-h-0 flex-1 flex-col px-5 pt-4 sm:px-10 lg:px-16">
        {/* column header */}
        <div
          className="flex items-center gap-3 px-4 pb-2 text-[11px] font-medium uppercase tracking-[0.04em]"
          style={{ color: DECK.muted }}
        >
          <span className="flex-1">
            {t("reports.competitorTemplate.competitor")}
          </span>
          {metricLabel && <span>{metricLabel}</span>}
        </div>

        {/* Centres when the rows fit; scrolls from the top when a short viewport
            can't hold all of them (the CTA below never gets overlapped). */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <ul className="my-auto flex flex-col gap-[min(0.375rem,0.8svh)] py-1">
            {competitors.map((c, i) => {
              const color = c.isYou
                ? DECK.muted
                : TONE_COLOR[c.tone ?? "neutral"];
              return (
                <li
                  key={i}
                  className="reveal flex items-center gap-3 rounded-xl px-3 py-[min(0.5rem,1svh)]"
                  data-show={active ? "true" : "false"}
                  style={{
                    ...(c.isYou
                      ? {
                          background: DECK.surface,
                          border: `1px solid ${DECK.border}`,
                        }
                      : {}),
                    transitionDelay: active ? `${60 + i * 60}ms` : "0ms",
                  }}
                >
                  <BrandTile
                    initial={(c.name[0] ?? "?").toUpperCase()}
                    faviconUrl={c.isYou ? faviconUrl : faviconFor(c.name)}
                  />
                  <span
                    className="flex-1 truncate text-[15px] sm:text-lg"
                    style={{ color: DECK.ink }}
                  >
                    {c.name}
                  </span>
                  <span
                    className="shrink-0 text-lg font-light tabular-nums tracking-[-0.02em] sm:text-2xl"
                    style={{ color }}
                  >
                    {c.value}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex shrink-0 justify-center py-[min(1rem,2.4svh)] sm:py-5">
          <a
            href={ctaHref}
            target={ctaHref.startsWith("http") ? "_blank" : "_self"}
            rel="noopener noreferrer"
            onClick={(e) =>
              trackConnectCta(e, { domain, placement: "competitor_slide_edit" })
            }
            className="inline-flex h-11 items-center rounded-full border px-7 text-[15px] font-medium transition-colors hover:bg-black/[0.03] sm:h-12 sm:px-8 sm:text-base"
            style={{
              borderColor: DECK.inputBorder,
              color: DECK.ink,
              background: DECK.surface,
            }}
          >
            {t("reports.competitorTemplate.editMyCompetitors")}
          </a>
        </div>
      </div>
    </div>
  );
}

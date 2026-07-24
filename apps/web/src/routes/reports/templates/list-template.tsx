import Icon from "../icon";
import { trackConnectCta } from "../onboarding";
import { useReportCtaHref } from "../use-report-cta-href";
import { DECK } from "./tokens";
import type { ListProps } from "@decocms/shared/reports/deck-types";

// Severity → badge colour + icon (Figma 8676-3927: bordered octagon badge).
const SEVERITY: Record<
  "error" | "warning" | "notice",
  { color: string; icon: string }
> = {
  error: { color: "#d43d3d", icon: "error" },
  warning: { color: DECK.warn, icon: "warning" },
  notice: { color: DECK.notice, icon: "info" },
};

/**
 * The closing "minor signals" round-up: one client-language claim per row, each
 * with a severity badge. Meant to feel OVERWHELMING — when `moreCount` > 0 the
 * TITLE itself is the tally ("+XX outros sinais no diagnóstico completo", the
 * big number in red), and a dense wall of warnings fades out below into the CTA
 * (which advances to the next slide, or falls back to onboarding).
 */
export default function ListTemplate({
  headline,
  entries,
  domain,
  onNext,
  moreCount,
  active,
}: ListProps) {
  const ctaHref = useReportCtaHref(domain);
  const cta = "Destravar minha receita";
  const ctaClass =
    "pointer-events-auto inline-flex h-12 items-center rounded-full border px-8 text-base font-medium transition-colors hover:bg-black/[0.03]";
  const ctaStyle = {
    borderColor: DECK.inputBorder,
    color: DECK.ink,
    background: DECK.surface,
  };
  const show = active ? "true" : "false";
  const titleClass =
    "reveal text-balance font-normal leading-[1.1] tracking-[-0.02em] text-[min(clamp(1.375rem,4.8vw,2.5rem),3svh)] sm:text-[clamp(1.5rem,3.2vw,2.5rem)] lg:text-[2.75rem] lg:max-w-[20ch]";

  return (
    <div className="flex h-full flex-col">
      {/* Header: when there are more signals, the count IS the title. No
          annotation here — the dense list below is overwhelming enough. */}
      <header className="flex shrink-0 flex-col gap-3 px-5 pt-2 sm:gap-4 sm:px-10 lg:px-16">
        <h2 className={titleClass} data-show={show} style={{ color: DECK.ink }}>
          {moreCount && moreCount > 0 ? (
            <>
              <span style={{ color: SEVERITY.error.color }}>+{moreCount}</span>{" "}
              outros sinais no diagnóstico completo
            </>
          ) : (
            headline.replace(/\s*\n\s*/g, " ")
          )}
        </h2>
      </header>

      <div className="relative min-h-0 flex-1 px-5 pt-3 sm:px-10 lg:px-16">
        {/* Clipped + bottom-faded — a dense wall of rows dissolving into the CTA. */}
        <ul
          className="h-full overflow-hidden"
          style={{
            maskImage: "linear-gradient(to bottom, #000 55%, transparent 92%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, #000 55%, transparent 92%)",
          }}
        >
          {entries.map((e, i) => {
            const sev = SEVERITY[e.severity] ?? SEVERITY.notice;
            return (
              <li
                key={i}
                className="reveal flex items-center gap-4 py-[min(9px,1.3svh)]"
                data-show={show}
                style={{
                  ...(i < entries.length - 1
                    ? { borderBottom: `1px solid ${DECK.border}` }
                    : {}),
                  transitionDelay: active ? `${60 + i * 45}ms` : "0ms",
                }}
              >
                <span
                  className="line-clamp-2 flex-1 text-[13px] leading-snug sm:text-[15px]"
                  style={{ color: DECK.muted }}
                >
                  {e.label}
                </span>
                <span
                  className="grid shrink-0 place-items-center"
                  style={{ color: sev.color }}
                  aria-label={e.severity}
                >
                  <Icon name={sev.icon} size="large" />
                </span>
              </li>
            );
          })}
        </ul>

        {/* CTA over the fade — advances to the next slide (or onboarding fallback). */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-5 pb-7 pt-24 sm:px-10 lg:px-16"
          style={{
            background: `linear-gradient(to bottom, transparent, ${DECK.bg} 34%)`,
          }}
        >
          {onNext ? (
            <button
              type="button"
              onClick={onNext}
              className={ctaClass}
              style={ctaStyle}
            >
              {cta}
            </button>
          ) : (
            <a
              href={ctaHref}
              target={ctaHref.startsWith("http") ? "_blank" : "_self"}
              rel="noopener noreferrer"
              onClick={(e) =>
                trackConnectCta(e, { domain, placement: "list_slide_fallback" })
              }
              className={ctaClass}
              style={ctaStyle}
            >
              {cta}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

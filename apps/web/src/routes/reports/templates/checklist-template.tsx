import Icon from "../icon";
import SlideHeader from "./slide-header";
import { DECK, TONE_COLOR } from "./tokens";
import type { ChecklistProps } from "@decocms/shared/reports/deck-types";

// Status → icon + colour.
const STATUS: Record<
  "pass" | "fail" | "warn",
  { color: string; icon: string }
> = {
  pass: { color: TONE_COLOR.good, icon: "check_circle" },
  fail: { color: TONE_COLOR.bad, icon: "cancel" },
  warn: { color: DECK.warn, icon: "error" },
};

/**
 * A pass/fail probe set — one row per check with a status icon and the observed
 * value. Chosen for presence/absence findings (security headers, cache, schema,
 * robots directives) instead of a grid of repeated "Ausente" stat tiles.
 */
export default function ChecklistTemplate({
  eyebrow,
  headline,
  annotation,
  checks,
  active,
}: ChecklistProps) {
  return (
    <div className="flex h-full flex-col">
      <SlideHeader
        eyebrow={eyebrow}
        headline={headline}
        annotation={annotation}
        active={active}
      />

      {/* Centered when the checks fit; scrolls from the top when they overflow
          (min-h-full wrapper) — so few rows don't leave a big empty bottom and
          many rows never overlap the header. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 sm:px-10 lg:px-16">
        <div className="flex min-h-full flex-col justify-center py-3">
          <ul className="w-full">
            {checks.map((c, i) => {
              const s = STATUS[c.status] ?? STATUS.fail;
              return (
                <li
                  key={i}
                  className="reveal flex items-center gap-4 py-[min(0.875rem,1.5svh)] sm:py-4"
                  data-show={active ? "true" : "false"}
                  style={{
                    ...(i < checks.length - 1
                      ? { borderBottom: `1px solid ${DECK.border}` }
                      : {}),
                    transitionDelay: active ? `${60 + i * 55}ms` : "0ms",
                  }}
                >
                  <span
                    className="grid shrink-0 place-items-center"
                    style={{ color: s.color }}
                  >
                    <Icon name={s.icon} size="large" />
                  </span>
                  {/* The label owns the row: a long observed value (an HSTS
                    header, a sample count) truncates instead of squeezing the
                    label into one-word-per-line wrapping on phones. */}
                  <span
                    className="min-w-0 flex-[2] text-[15px] leading-snug sm:text-lg"
                    style={{ color: DECK.ink }}
                  >
                    {c.label}
                  </span>
                  {c.value && (
                    <span
                      className="min-w-0 flex-1 truncate text-right text-[13px] font-medium tabular-nums sm:text-base"
                      style={{ color: s.color }}
                      title={c.value}
                    >
                      {c.value}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

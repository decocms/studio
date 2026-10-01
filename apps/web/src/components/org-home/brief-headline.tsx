/**
 * The top of a daily brief: one ranked sentence, then the evidence for it —
 * including the month's cost, which comes free off the board's own threads.
 *
 * Shared by both briefs: the org's home leads with a greeting, a project's with
 * the date and a workflow's paragraph.
 */

import type { ReactNode } from "react";
import { useT } from "@/i18n/use-t.ts";
import type { TFunction, TranslationKey } from "@/i18n/use-t.ts";
import type { DailyPulse } from "./daily-pulse";

/**
 * Three clauses, each its own key, each omitted at zero. Composed from counted
 * noun phrases rather than eight pre-written variants, so the dictionary stays
 * small; the phrases carry their own singular.
 */
function phrase(
  t: TFunction,
  keys: readonly [TranslationKey, TranslationKey],
  count: number,
): string {
  return t(keys[count === 1 ? 0 : 1], { count });
}

const CHANGES = [
  "home.brief.changeOne",
  "home.brief.changeMany",
] as const satisfies readonly [TranslationKey, TranslationKey];
const INCIDENTS = [
  "home.brief.incidentOne",
  "home.brief.incidentMany",
] as const satisfies readonly [TranslationKey, TranslationKey];
const WAITING = [
  "home.brief.waitingOne",
  "home.brief.waitingMany",
] as const satisfies readonly [TranslationKey, TranslationKey];

function leadSentence(
  t: TFunction,
  pulse: DailyPulse,
  waiting: number,
  greeting: string | null,
): string {
  const clauses: string[] = [];
  if (greeting) clauses.push(greeting);

  const changes = phrase(t, CHANGES, pulse.shipped);
  const incidents = phrase(t, INCIDENTS, pulse.failed);
  if (pulse.shipped > 0 && pulse.failed > 0) {
    clauses.push(t("home.brief.overnightBoth", { changes, incidents }));
  } else if (pulse.shipped > 0) {
    clauses.push(t("home.brief.overnightShipped", { changes }));
  } else if (pulse.failed > 0) {
    clauses.push(t("home.brief.overnightFailed", { incidents }));
  }

  clauses.push(
    waiting > 0 ? phrase(t, WAITING, waiting) : t("home.brief.waitingNone"),
  );
  return clauses.join(" ");
}

/** Today, spelled out: a brief is dated, a dashboard is not. */
export function briefDate(locale: string, now: Date): string {
  return now.toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export function BriefHeadline({
  /** The line above the lead — the brief's date. */
  eyebrow,
  /** Opens the sentence ("Good morning, Rafael.") when there is one. */
  greeting,
  pulse,
  waiting,
  /** Rendered under the lead — a workflow's paragraph. */
  children,
}: {
  eyebrow: string;
  greeting?: string;
  pulse: DailyPulse;
  waiting: number;
  children?: ReactNode;
}) {
  const t = useT();

  return (
    <div className="flex flex-col gap-3.5">
      <p className="text-sm text-muted-foreground">{eyebrow}</p>
      {/* Set in the product's own typeface at display weight. The authority
          comes from size and tracking, not from borrowing a second family —
          see the `font-display` utility. Smaller on a phone, where the
          display size turned one sentence into six lines. */}
      <h1 className="font-display max-w-[40ch] text-2xl leading-[1.22] text-foreground sm:text-[2.125rem] sm:leading-[1.18]">
        {leadSentence(t, pulse, waiting, greeting ?? null)}
      </h1>
      {children}
    </div>
  );
}

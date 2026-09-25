/**
 * The top of a daily brief: one sentence, then the evidence for it.
 *
 * The sentence is ranked, not summed. A headline that recites every number
 * ("14 shipped, 3 failed, 2 in review, 13 opened") has made the reader do the
 * ranking, which is the work the page exists to do — so the lead states the one
 * thing that wants them most, and everything else drops to the quiet line
 * underneath.
 *
 * That line carries the bill. An operator being asked to trust agents with
 * their storefront is owed the cost in the same glance as the result, and it
 * comes free off the board's own threads.
 *
 * Shared by both briefs: the org's home leads with a greeting, a project's
 * leads with the date and the paragraph a workflow wrote. Same shape, because
 * they are the same page in two scopes.
 */

import type { ReactNode } from "react";
import { useT } from "@/i18n/use-t.ts";
import type { TFunction, TranslationKey } from "@/i18n/use-t.ts";
import type { DailyPulse } from "./daily-pulse";

/**
 * The brief's sentence, built from counted noun phrases.
 *
 * Three clauses, each its own key, each omitted when its count is zero: the
 * greeting, what happened overnight, and what is stopped on you. Composing the
 * sentence from phrases ("14 changes", "1 incident") rather than from eight
 * pre-written variants is what keeps it prose without making the dictionary
 * combinatorial — and the phrases carry their own singular, because "shipped 1
 * changes" in the page's one full sentence is the seam that makes a reader stop
 * trusting the numbers beside it.
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

/** Today, spelled out — the one thing that makes a page feel like a brief
 *  rather than a dashboard: it is dated, and the date is a claim. */
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
          see the `font-display` utility. */}
      <h1 className="font-display max-w-[40ch] text-[2.125rem] leading-[1.18] text-foreground">
        {leadSentence(t, pulse, waiting, greeting ?? null)}
      </h1>
      {children}
    </div>
  );
}

/**
 * The top of a daily brief: one ranked sentence, then the evidence for it —
 * including the month's cost, which comes free off the board's own threads.
 *
 * Shared by both briefs: the org's home leads with a greeting, a project's with
 * the date and a workflow's paragraph.
 */

import type { ReactNode } from "react";
import { useT } from "@/i18n/use-t.ts";
import type { TFunction } from "@/i18n/use-t.ts";
import type { PulseWindow } from "./greeting";

function leadSentence(
  t: TFunction,
  shipped: number,
  window: PulseWindow,
  waiting: number,
  running: number,
  greeting: string | null,
): string {
  const clauses: string[] = [];
  if (greeting) clauses.push(greeting);

  if (shipped > 0) {
    const changes = t(
      shipped === 1 ? "home.brief.changeOne" : "home.brief.changeMany",
      { count: shipped },
    );
    clauses.push(
      t(
        window === "overnight"
          ? "home.brief.overnightShipped"
          : "home.brief.todayShipped",
        { changes },
      ),
    );
  }

  if (shipped === 0 && waiting === 0) {
    clauses.push(
      t(
        running > 0
          ? "home.brief.working"
          : window === "overnight"
            ? "home.brief.quietNight"
            : "home.brief.quietDay",
      ),
    );
  }

  clauses.push(
    waiting === 0
      ? t("home.brief.waitingNone")
      : t(waiting === 1 ? "home.brief.waitingOne" : "home.brief.waitingMany", {
          count: waiting,
        }),
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
  shipped,
  window,
  waiting,
  running,
  /** Rendered under the lead — a workflow's paragraph. */
  children,
}: {
  eyebrow: string;
  greeting?: string;
  /** Cards shipped inside `window`. */
  shipped: number;
  window: PulseWindow;
  /** Cards stopped on the reader. */
  waiting: number;
  /** Agent runs in progress right now. */
  running: number;
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
        {leadSentence(t, shipped, window, waiting, running, greeting ?? null)}
      </h1>
      {children}
    </div>
  );
}

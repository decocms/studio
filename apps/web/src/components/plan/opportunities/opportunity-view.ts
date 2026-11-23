/**
 * What the "Found for you" section shows, read from the engine's store view.
 * Pure, so every number and state on the cards is tested here; the components
 * only lay it out.
 */

import type {
  Lifecycle,
  PageType,
  StoreOpportunity,
  StoreOpportunityHypothesis,
  StoreView,
} from "./diagnosis-schema.ts";

/** The engine's page order, which is also the funnel's. */
const PAGE_ORDER: readonly PageType[] = [
  "home",
  "categoria",
  "busca",
  "pdp",
  "carrinho_checkout",
];

type HypothesisLike = Pick<StoreOpportunityHypothesis, "lifecycle" | "status">;

const isReady = (h: HypothesisLike) =>
  h.lifecycle === "pronta_para_experimento" && h.status !== "dismissed";

export type CardState = "ready" | "investigating";

/** Ready once a hypothesis the member has not dismissed is ready to test. */
export function cardState(o: Pick<StoreOpportunity, "hypotheses">): CardState {
  return o.hypotheses.some(isReady) ? "ready" : "investigating";
}

export type DataBadge = "reliable" | "low_sample";

export function dataBadge(
  o: Pick<StoreOpportunity, "reliability">,
): DataBadge | null {
  switch (o.reliability?.level) {
    case "alta":
      return "reliable";
    case "baixa":
      return "low_sample";
    default:
      return null;
  }
}

export type HypothesisVerdict =
  | "confirmed"
  | "refuted"
  | "inconclusive"
  | "pending";

/** Lifecycle states that come after the cause was confirmed. A rewritten
 *  cause counts as confirmed only once the engine moved it into one. */
const CONFIRMED_LIFECYCLES: ReadonlySet<Lifecycle> = new Set([
  "condicao_confirmada",
  "relevancia_avaliada",
  "pronta_para_experimento",
  "sem_relevancia",
]);

function verdictOf(h: StoreOpportunityHypothesis): HypothesisVerdict {
  const verdict = h.verification?.verdict;
  if (verdict === "desmentida" || h.lifecycle === "refutada") return "refuted";
  if (verdict === "confirmada") return "confirmed";
  if (verdict === "reescrita") {
    return CONFIRMED_LIFECYCLES.has(h.lifecycle) ? "confirmed" : "inconclusive";
  }
  if (verdict === "inconclusiva") return "inconclusive";
  return "pending";
}

export function hypothesisLine(h: StoreOpportunityHypothesis): {
  text: string;
  verdict: HypothesisVerdict;
  strike: boolean;
} {
  const verdict = verdictOf(h);
  return { text: h.title, verdict, strike: verdict === "refuted" };
}

/**
 * The first ready hypothesis by `rank`. The store view's summaries carry no
 * rank but already come in rank order, so without one the order is kept.
 */
export function readyHypothesis<
  H extends HypothesisLike & { rank?: number },
>(o: { hypotheses: readonly H[] }): H | null {
  const byRank = (h: H) => h.rank ?? Number.POSITIVE_INFINITY;
  return (
    o.hypotheses.filter(isReady).toSorted((a, b) => byRank(a) - byRank(b))[0] ??
    null
  );
}

export function hypothesesTally(o: Pick<StoreOpportunity, "hypotheses">): {
  total: number;
  ready: number;
  confirmed: number;
} {
  return {
    total: o.hypotheses.length,
    ready: o.hypotheses.filter(isReady).length,
    confirmed: o.hypotheses.filter((h) => verdictOf(h) === "confirmed").length,
  };
}

export function summaryNumbers(v: StoreView): {
  measured: number;
  pages: number;
  chosen: number;
  topMonthly: number;
} {
  return {
    measured: v.top.length + v.others.length,
    pages: v.pages.length,
    chosen: v.top.length,
    topMonthly: v.top.reduce(
      (sum, o) => sum + (o.money?.monthly_value ?? 0),
      0,
    ),
  };
}

/** An error's message for detail text under a translated headline. */
export function errorText(error: unknown): string | null {
  return error instanceof Error && error.message ? error.message : null;
}

/** The engine's money is in BRL; the reader's language sets the format. */
export function formatMoney(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "BRL",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export type SectionPhase =
  | { phase: "results"; refreshing: boolean }
  | { phase: "running" }
  | { phase: "no_sources" }
  | { phase: "empty" };

/** A run that starts over keeps the last result on screen until it ends. A
 *  finished run with nothing found and named gaps lacked sources, so running
 *  it again would not help until they are connected. */
export function sectionPhase(v: StoreView): SectionPhase {
  if (v.top.length + v.others.length > 0) {
    return { phase: "results", refreshing: v.running };
  }
  if (v.running) return { phase: "running" };
  return viewGaps(v).length > 0 ? { phase: "no_sources" } : { phase: "empty" };
}

/** The sources that did not answer, named once across pages. */
export function viewGaps(v: StoreView): string[] {
  return [...new Set(v.pages.flatMap((p) => p.gaps))];
}

/** Which pages the view covers, and when the latest of them was analysed. */
export function viewScope(v: StoreView): {
  whole: boolean;
  pages: PageType[];
  analysedAt: string | null;
} {
  const covered = new Set(v.pages.map((p) => p.page_type));
  const latest = v.pages.reduce<{ at: string; time: number } | null>(
    (best, p) => {
      const time = Date.parse(p.analysed_at);
      return best && best.time >= time ? best : { at: p.analysed_at, time };
    },
    null,
  );
  return {
    whole: PAGE_ORDER.every((p) => covered.has(p)),
    pages: PAGE_ORDER.filter((p) => covered.has(p)),
    analysedAt: latest?.at ?? null,
  };
}

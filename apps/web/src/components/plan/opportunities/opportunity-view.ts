/**
 * What the "Found for you" section shows, read from the engine's store view.
 * Pure, so every number and state on the cards is tested here; the components
 * only lay it out.
 */

import { z } from "zod";
import {
  isSetupKey,
  type GapDetail,
  type Lifecycle,
  OpportunityHypothesis,
  PageType,
  SetupKey,
  SetupNeed,
  StartRunInput,
  StartRunResult,
  StoreOpportunity,
  StoreOpportunityHypothesis,
  StorePage,
  StoreView,
} from "./diagnosis-schema.ts";
import { DiagnosisEngineError } from "./diagnosis-state.ts";

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

/** The blocking need a refused run asks for, in the engine's order: the
 *  domain (also from an engine that only flags it), then an AI provider. */
export function runRefusal(error: unknown): "domain" | "ai_provider" | null {
  if (!(error instanceof DiagnosisEngineError)) return null;
  const blocking = error.needs.filter((n) => n.blocking).map((n) => n.key);
  if (blocking.includes("domain")) return "domain";
  if (blocking.includes("ai_provider")) return "ai_provider";
  return blocking.length === 0 && error.needsDomain ? "domain" : null;
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

/** An engine rate (0–1) as a percent, with up to `digits` decimals. */
export function formatPercent(
  rate: number,
  locale: string,
  digits = 1,
): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: digits,
  }).format(rate);
}

export function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
    value,
  );
}

export type SectionPhase =
  | { phase: "results"; refreshing: boolean }
  | { phase: "running" }
  | { phase: "failed" }
  | { phase: "no_sources" }
  | { phase: "empty" };

/** A run that starts over keeps the last result on screen until it ends.
 *  The engine names gaps even when other sources answered, so only a run
 *  with no source at all reads as lacking sources. */
export function sectionPhase(v: StoreView): SectionPhase {
  if (v.top.length + v.others.length > 0) {
    return { phase: "results", refreshing: v.running };
  }
  if (v.running) return { phase: "running" };
  if (v.pages.length > 0 && v.pages.every((p) => p.status === "error")) {
    return { phase: "failed" };
  }
  return v.sources.length === 0 && viewGaps(v).length > 0
    ? { phase: "no_sources" }
    : { phase: "empty" };
}

/** The sources that did not answer, named once across pages. */
export function viewGaps(v: StoreView): string[] {
  return [...new Set(v.pages.flatMap((p) => p.gaps))];
}

/** What the setup card asks for, narrowed to the needs this Studio knows. */
export function setupNeeds(v: StoreView): (SetupNeed & { key: SetupKey })[] {
  return (v.setup?.needs ?? []).flatMap((n) =>
    isSetupKey(n.key) ? [{ ...n, key: n.key }] : [],
  );
}

/** Gaps split by who can close them: what the customer provides (once per
 *  key) and the analysis's own limits. An engine without `gap_details` has
 *  no owners, so its gaps come back `legacy`, to be listed as they are. */
export function gapGroups(v: StoreView): {
  legacy: boolean;
  customer: GapDetail[];
  limitations: string[];
} {
  const details = v.pages.flatMap((p) => p.gap_details ?? []);
  if (!v.pages.some((p) => p.gap_details)) {
    return { legacy: true, customer: [], limitations: viewGaps(v) };
  }
  const customer = new Map<string, GapDetail>();
  const limitations = new Set<string>();
  for (const d of details) {
    if (d.owner === "customer" && d.key !== undefined && isSetupKey(d.key)) {
      if (!customer.has(d.key)) customer.set(d.key, d);
    } else {
      limitations.add(d.message);
    }
  }
  return {
    legacy: false,
    customer: [...customer.values()],
    limitations: [...limitations],
  };
}

/** A page's first analysis carries its start as `analysed_at`, so until it
 *  has a result there is no analysis date to show. */
export function showsAnalysedAt(v: StoreView, page: StorePage): boolean {
  if (page.status !== "running") return true;
  return (
    page.funnel.length > 0 ||
    page.capture_url !== null ||
    pageLosses(v, page.page_type).length > 0
  );
}

/** Which pages the view covers, and when the latest of them was analysed. */
export function viewScope(v: StoreView): {
  whole: boolean;
  pages: PageType[];
  analysedAt: string | null;
} {
  const covered = new Set(v.pages.map((p) => p.page_type));
  const dated = v.pages.filter((p) => showsAnalysedAt(v, p));
  const latest = dated.reduce<{ at: string; time: number } | null>(
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

// ── The loss's detail ────────────────────────────────────────────────────────

/** The engine's own rule (`canApprove`): only a ready hypothesis goes to test. */
export function canApprove(h: Pick<OpportunityHypothesis, "lifecycle">) {
  return h.lifecycle === "pronta_para_experimento";
}

/** What the member can do with a hypothesis. A decision is undone by setting
 *  it back to pending, which the engine accepts. */
export function hypothesisActions(
  h: Pick<OpportunityHypothesis, "lifecycle" | "status">,
): {
  decision: OpportunityHypothesis["status"];
  approve: boolean;
  dismiss: boolean;
  undo: boolean;
} {
  const pending = h.status === "pending";
  return {
    decision: h.status,
    approve: pending && canApprove(h),
    dismiss: pending,
    undo: !pending,
  };
}

export function detailHypotheses<H extends { rank: number }>(o: {
  hypotheses: readonly H[];
}): H[] {
  return o.hypotheses.toSorted((a, b) => a.rank - b.rank);
}

/** Engine text carries links; only http(s) ones become an `href`. */
export function safeHref(value: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

/** Engine images load only over https. */
export function safeImageSrc(value: string | null): string | null {
  const href = safeHref(value);
  return href?.startsWith("https:") ? href : null;
}

const OpportunityIdSchema = z.string().trim().min(1).max(128);

/** The route's `$opportunityId`, or null when it cannot be an engine id. */
export function parseOpportunityId(value: unknown): string | null {
  const parsed = OpportunityIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The engine answers an id it does not hold for this org, another org's
 *  included, with "não encontrada"; that is a missing page, not a retry. */
export function detailFailure(error: unknown): "not_found" | "error" {
  return error instanceof DiagnosisEngineError &&
    /não encontrad|not found/i.test(error.message)
    ? "not_found"
    : "error";
}

// ── The store, step by step ──────────────────────────────────────────────────

export type StageBadge = "top" | "second" | "at_stake" | "running";

export interface StageCard {
  page_type: PageType;
  /** The view has an analysis of this page. */
  analysed: boolean;
  /** Null when the page's analysis has no funnel for this device. */
  people_week: number | null;
  advance_rate: number | null;
  badge: StageBadge | null;
  /** The biggest loss measured on the page, a month. */
  at_stake: number | null;
}

type Device = StorePage["funnel"][number]["device"];

function pageOf(v: StoreView, page: PageType): StorePage | undefined {
  return v.pages.find((p) => p.page_type === page);
}

/** A page's losses, the engine's order kept: top ones first, then the rest. */
export function pageLosses(v: StoreView, page: PageType): StoreOpportunity[] {
  return [...v.top, ...v.others].filter((o) => o.page_type === page);
}

/** One card per funnel stage, home to checkout. The top and second badges
 *  follow the engine's own `top` order; a page running again says so first. */
export function stageCards(v: StoreView, device: Device): StageCard[] {
  const [first, second] = v.top;
  return PAGE_ORDER.map((page_type) => {
    const page = pageOf(v, page_type);
    const point = page?.funnel.find((f) => f.device === device);
    const values = pageLosses(v, page_type).flatMap((o) =>
      o.money ? [o.money.monthly_value] : [],
    );
    const at_stake = values.length > 0 ? Math.max(...values) : null;
    const badge: StageBadge | null =
      page?.status === "running"
        ? "running"
        : first?.page_type === page_type
          ? "top"
          : second?.page_type === page_type
            ? "second"
            : at_stake !== null && at_stake > 0
              ? "at_stake"
              : null;
    return {
      page_type,
      analysed: page !== undefined,
      people_week: point?.people_week ?? null,
      advance_rate: point?.advance_rate ?? null,
      badge,
      at_stake,
    };
  });
}

/** Every page a new analysis can cover. A page already running cannot be
 *  asked again: the engine would hand back the same run. */
export function runnablePages(
  v: StoreView | undefined,
): { page_type: PageType; disabled: boolean; analysed_at: string | null }[] {
  return PAGE_ORDER.map((page_type) => {
    const page = v && pageOf(v, page_type);
    return {
      page_type,
      disabled: page?.status === "running",
      analysed_at: page?.analysed_at ?? null,
    };
  });
}

/** The page the store tab opens on: the biggest loss's, else the first in
 *  funnel order with funnel data, else the first analysed. */
export function defaultStorePage(v: StoreView): PageType | null {
  const top = v.top[0]?.page_type;
  if (top && pageOf(v, top)) return top;
  const analysed = PAGE_ORDER.filter((p) => pageOf(v, p));
  return (
    analysed.find((p) => (pageOf(v, p)?.funnel.length ?? 0) > 0) ??
    analysed[0] ??
    null
  );
}

/** The engine's limit on the goal text it keeps with a run. */
const OBJECTIVE_MAX = 280;

/** What `start_ux_diagnosis` gets: the whole site or the chosen pages, with
 *  the active goal so the run stays on it if the goal changes later. */
export function startRunInput(
  goal: { id: string | null; statement: string | null },
  scope: "site" | readonly PageType[],
): StartRunInput {
  const statement = goal.statement?.trim().slice(0, OBJECTIVE_MAX);
  return {
    ...(scope === "site"
      ? { todas: true }
      : { pages: PAGE_ORDER.filter((p) => scope.includes(p)) }),
    ...(goal.id ? { goal_id: goal.id } : {}),
    ...(statement ? { objective_statement: statement } : {}),
  };
}

/** `plan_run_requested`'s properties. */
export function runRequestedEvent(input: StartRunInput): {
  scope: "site" | "pages";
  count: number;
} {
  return input.todas
    ? { scope: "site", count: PAGE_ORDER.length }
    : { scope: "pages", count: input.pages?.length ?? 0 };
}

/** Pages the engine said were already running, in a run this goal's view
 *  does not show: the lock is per org, the view is per goal. */
export function runningElsewhere(
  result: StartRunResult,
  v: StoreView | undefined,
): PageType[] {
  return result.diagnoses
    .filter(
      (d) =>
        d.already_running &&
        !v?.pages.some((p) => p.diagnosis_id === d.diagnosis_id),
    )
    .map((d) => d.page_type);
}

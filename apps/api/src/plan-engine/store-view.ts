/**
 * The store at once, for Studio's Plan: each page's latest analysis, its funnel
 * by device, the biggest losses and the sources that answered. Pure over DB rows;
 * funnel numbers come from `measureMetric` (metrics.ts).
 */

import type {
  GapDetail,
  StoreFunnelPoint,
  StoreOpportunity,
  StorePage,
  StoreSource,
  StoreView,
} from "./contract.ts";
import { STORE_SOURCES } from "./contract.ts";
import { lifecycleOf } from "./lifecycle.ts";
import { measureMetric } from "./metrics.ts";
import { PAGE_TYPE_ORDER, pageSpec } from "./page-types.ts";
import { buildSetup, gapDetail } from "./setup.ts";
import type {
  DiagnosisEvidence,
  SiteProfile,
  SourceGap,
  UxArea,
  UxDevice,
  UxDiagnosis,
  UxHypothesis,
  UxOpportunity,
  UxPageType,
} from "./types.ts";

/** A diagnosis without the evidence is enough to choose; with it, to build. */
type DiagnosisRow = Omit<UxDiagnosis, "evidence"> & {
  evidence?: DiagnosisEvidence | null;
};

/** Has a result to show: finished, or re-verifying an analysis that had finished. */
const hasResults = (d: DiagnosisRow) =>
  d.status === "done" || (d.status === "running" && d.finished_at !== null);

/** A tie on the same instant keeps entry order (the database's, by insertion). */
const newestFirst = (a: DiagnosisRow, b: DiagnosisRow) =>
  b.started_at.localeCompare(a.started_at);

export interface PageChoice<D extends DiagnosisRow> {
  /** The page's newest analysis: the state the screen shows. */
  latest: D;
  /** The newest with a result: the losses, the funnel and the screenshot. */
  results: D | null;
}

/** Per page, the newest analysis and the newest with a result. */
export function choosePageDiagnoses<D extends DiagnosisRow>(
  diagnoses: D[],
  goalId?: string | null,
): Map<UxPageType, PageChoice<D>> {
  const out = new Map<UxPageType, PageChoice<D>>();
  const mine = diagnoses
    .filter((d) => !goalId || d.goal_id === goalId)
    .sort(newestFirst);
  for (const d of mine) {
    const choice = out.get(d.page_type);
    if (!choice) {
      out.set(d.page_type, { latest: d, results: hasResults(d) ? d : null });
    } else if (!choice.results && hasResults(d)) {
      choice.results = d;
    }
  }
  return out;
}

/** A loss a page reports on ANOTHER page already covered by that page's own analysis; it stays only there. */
export function coveredElsewhere(
  area: UxArea,
  pages: ReadonlySet<UxPageType>,
): boolean {
  return (
    (area === "carrinho_checkout" && pages.has("carrinho_checkout")) ||
    (area === "navegacao" &&
      (pages.has("home") || pages.has("categoria") || pages.has("busca")))
  );
}

/** By value (R$/month), then confidence; without a money estimate it goes last. */
export const byValue = (
  a: Pick<UxOpportunity, "money" | "confidence">,
  b: Pick<UxOpportunity, "money" | "confidence">,
) =>
  (b.money?.monthly_value ?? -1) - (a.money?.monthly_value ?? -1) ||
  b.confidence - a.confidence;

const DEVICES: UxDevice[] = ["mobile", "desktop"];

/** The page's default stage by device: weekly arrivals and the rate moving on to the next. */
export function pageFunnel(
  evidence: DiagnosisEvidence,
  pageType: UxPageType,
): StoreFunnelPoint[] {
  const key = pageSpec(pageType).defaultMetric;
  return DEVICES.flatMap((device) => {
    const m = measureMetric(
      evidence,
      { key, device, compare_to: null },
      pageType,
    );
    if (!m) return [];
    return [
      {
        device,
        // Same weekly computation as the test design (experiment.ts).
        people_week: Math.round((m.n * 7) / (evidence.window_days || 7)),
        advance_rate: m.rate,
      },
    ];
  });
}

/** The sources that brought data into this evidence. */
function evidenceSources(evidence: DiagnosisEvidence): StoreSource[] {
  const has: Record<StoreSource, boolean> = {
    GA4: evidence.platform_funnel.some((f) => f.steps.length > 0),
    "Deco Analytics": evidence.pdp_behaviour.length > 0,
    VTEX: evidence.revenue !== null || evidence.products.length > 0,
    "Página ao vivo": evidence.captures.length > 0,
    Código: Boolean(evidence.repo_snapshot_key),
  };
  return STORE_SOURCES.filter((s) => has[s]);
}

function captureOf(evidence: DiagnosisEvidence | null | undefined) {
  const captures = evidence?.captures ?? [];
  const fold = (device: UxDevice) =>
    captures.find((c) => c.device === device && c.fold_url)?.fold_url;
  return (
    fold("mobile") ??
    fold("desktop") ??
    captures.find((c) => c.full_url)?.full_url ??
    null
  );
}

export function buildStoreView(input: {
  diagnoses: DiagnosisRow[];
  opportunities: UxOpportunity[];
  hypotheses: UxHypothesis[];
  goalId?: string | null;
  /** The store profile; null = the store has no domain yet. */
  profile: SiteProfile | null;
  /** False = the org has no AI model, so setup asks for a provider. */
  hasModel?: boolean;
}): StoreView {
  const chosen = choosePageDiagnoses(input.diagnoses, input.goalId);
  const resultIds = new Map<string, UxPageType>();
  for (const [page, c] of chosen) {
    if (c.results) resultIds.set(c.results.id, page);
  }
  const withResults = new Set(resultIds.values());

  const hypothesesOf = new Map<string, UxHypothesis[]>();
  for (const h of input.hypotheses) {
    if (h.kind !== "proposta" || !h.opportunity_id) continue;
    const list = hypothesesOf.get(h.opportunity_id) ?? [];
    list.push(h);
    hypothesesOf.set(h.opportunity_id, list);
  }

  const included: StoreOpportunity[] = input.opportunities
    .filter((o) => resultIds.has(o.diagnosis_id))
    .filter((o) => !o.outcome?.retired)
    .filter((o) => !coveredElsewhere(o.area, withResults))
    .map((o) => ({
      ...o,
      page_type: resultIds.get(o.diagnosis_id) as UxPageType,
      hypotheses: (hypothesesOf.get(o.id) ?? [])
        .sort((a, b) => a.rank - b.rank)
        .map((h) => ({
          id: h.id,
          title: h.title,
          lifecycle: lifecycleOf(h),
          verification: h.verification
            ? {
                verdict: h.verification.verdict,
                summary: h.verification.summary,
              }
            : null,
          status: h.status,
        })),
    }))
    .sort(byValue);

  const sources = new Set<StoreSource>();
  const pageGaps: SourceGap[] = [];
  const pages: StorePage[] = PAGE_TYPE_ORDER.flatMap((pageType) => {
    const c = chosen.get(pageType);
    if (!c) return [];
    const { latest, results } = c;
    const evidence = results?.evidence ?? null;
    if (evidence) for (const s of evidenceSources(evidence)) sources.add(s);
    const funnel = evidence ? pageFunnel(evidence, pageType) : [];
    const gapSource = (results ?? latest).evidence?.gaps ?? [];
    pageGaps.push(...gapSource);
    const gap_details: GapDetail[] = gapSource.map(gapDetail);
    if (
      evidence &&
      funnel.length === 0 &&
      !gapSource.some((g) => g.source === "bigquery" || g.source === "heatmap")
    ) {
      gap_details.push({
        source: "bigquery",
        owner: "ours",
        message: "Funil: esta análise não tem dado de funil da página",
      });
    }
    const observations = [
      ...new Set(
        included
          .filter((o) => o.diagnosis_id === results?.id)
          .flatMap((o) => (o.observations ?? []).map((x) => x.text)),
      ),
    ];
    const shown = results ?? latest;
    return [
      {
        page_type: pageType,
        diagnosis_id: latest.id,
        analysed_at: shown.finished_at ?? shown.started_at,
        status: latest.status,
        stage: latest.status === "done" ? null : latest.stage,
        progress_note:
          latest.status === "running"
            ? latest.progress_note
            : latest.status === "error"
              ? latest.error
              : null,
        funnel,
        capture_url: captureOf(evidence),
        observations,
        gaps: gap_details.map((g) => g.message),
        gap_details,
      },
    ];
  });

  return {
    pages,
    top: included.slice(0, 2),
    others: included.slice(2),
    sources: STORE_SOURCES.filter((s) => sources.has(s)),
    running: pages.some((p) => p.status === "running"),
    setup: buildSetup(input.profile, pageGaps, input.hasModel),
  };
}

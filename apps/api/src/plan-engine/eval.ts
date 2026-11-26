/**
 * Diagnosis metrics computed over a STORED diagnosis (the `get_ux_diagnosis`
 * JSON) with no model spend, to compare a new round against a baseline
 * (scripts/ux-eval.ts).
 */

import { checkGrounding, factBook, factIndex } from "./facts.ts";
import { opportunitiesFromLosses } from "./loss-opportunities.ts";
import type {
  DiagnosisEvidence,
  UxHypothesis,
  UxOpportunity,
} from "./types.ts";

/** A human verdict on a stored hypothesis. */
export interface EvalLabel {
  /** First 8 characters of the diagnosis id (enough). */
  diagnosis: string;
  /** A piece of the hypothesis title (case-insensitive). */
  match: string;
  verdict: "aceita" | "derrubada";
  motivo: string;
}

export interface EvalReport {
  diagnosis_id: string;
  page_type: string;
  cost_usd: number | null;
  minutes: number | null;
  opportunities: {
    total: number;
    with_comparison: number;
    /** Titles that are not a measured loss (no number, or naming the cause). */
    cause_like_titles: string[];
    /** What today's code would build from the same evidence. */
    today: { total: number; titles: string[] };
  };
  hypotheses: {
    total: number;
    with_cited_facts: number;
    fact_claims: number;
    /** "fato_observado" whose text is in the cited facts. */
    fact_claims_grounded: number;
    refuted: number;
    inconclusive: number;
    blocked: number;
    ready: number;
  };
  labels: {
    agree: string[];
    disagree: string[];
  };
}

/** The title is a measured loss: names the screen or audience and carries a number. Exported for tests. */
export function isLossTitle(title: string): boolean {
  return /\d/.test(title) && /(celular|computador)/i.test(title);
}

const STATES = {
  refuted: "refutada",
  inconclusive: "inconclusiva",
  blocked: "bloqueada",
  ready: "pronta_para_experimento",
} as const;

/** Metrics of a stored diagnosis. */
export function evaluateDiagnosis(
  raw: {
    diagnosis: {
      id: string;
      page_type?: string | null;
      cost_usd?: number | null;
      started_at?: string | null;
      finished_at?: string | null;
      evidence?: DiagnosisEvidence | null;
    };
    opportunities?: UxOpportunity[];
    hypotheses?: UxHypothesis[];
  },
  labels: EvalLabel[] = [],
): EvalReport {
  const d = raw.diagnosis;
  const opportunities = (raw.opportunities ?? []).filter(
    (o) => !o.outcome?.retired,
  );
  const hypotheses = (raw.hypotheses ?? []).filter(
    (h) => h.kind === "proposta" && h.opportunity_id,
  );
  const evidence = d.evidence ?? null;
  const book = evidence ? factIndex(factBook(evidence)) : new Map();
  const today = evidence ? opportunitiesFromLosses(evidence) : null;

  let factClaims = 0;
  let grounded = 0;
  let withFacts = 0;
  for (const h of hypotheses) {
    const claims = [...(h.tree?.a_favor ?? []), ...(h.tree?.contra ?? [])];
    if (claims.some((c) => (c.facts ?? []).length > 0)) withFacts++;
    for (const c of claims) {
      if (c.label !== "fato_observado") continue;
      factClaims++;
      const g = checkGrounding(c.text, c.facts ?? [], book);
      if (
        g.facts.length > 0 &&
        g.unknown.length === 0 &&
        g.unsupported.length === 0
      ) {
        grounded++;
      }
    }
  }
  const count = (state: string) =>
    hypotheses.filter((h) => h.lifecycle === state).length;

  const mine = labels.filter((l) => d.id.startsWith(l.diagnosis));
  const agree: string[] = [];
  const disagree: string[] = [];
  for (const l of mine) {
    const h = hypotheses.find((x) =>
      x.title.toLowerCase().includes(l.match.toLowerCase()),
    );
    // Human-rejected: right if it did not stand; accepted: right if it stood (not refuted or blocked)
    const standing =
      !!h &&
      h.lifecycle !== STATES.refuted &&
      h.lifecycle !== STATES.blocked &&
      h.status !== "dismissed";
    const ok = l.verdict === "derrubada" ? !standing : standing;
    (ok ? agree : disagree).push(`${l.match} (${l.verdict}: ${l.motivo})`);
  }

  const started = d.started_at ? Date.parse(d.started_at) : Number.NaN;
  const finished = d.finished_at ? Date.parse(d.finished_at) : Number.NaN;
  return {
    diagnosis_id: d.id,
    page_type: d.page_type ?? "pdp",
    cost_usd: d.cost_usd ?? null,
    minutes: Number.isFinite(finished - started)
      ? Math.round((finished - started) / 60_000)
      : null,
    opportunities: {
      total: opportunities.length,
      with_comparison: opportunities.filter(
        (o) =>
          o.metric?.control === "dispositivo" ||
          o.metric?.control === "segmento",
      ).length,
      cause_like_titles: opportunities
        .filter((o) => !isLossTitle(o.title))
        .map((o) => o.title),
      today: {
        total: today?.opportunities.length ?? 0,
        titles: (today?.opportunities ?? []).map((o) => o.title),
      },
    },
    hypotheses: {
      total: hypotheses.length,
      with_cited_facts: withFacts,
      fact_claims: factClaims,
      fact_claims_grounded: grounded,
      refuted: count(STATES.refuted),
      inconclusive: count(STATES.inconclusive),
      blocked: count(STATES.blocked),
      ready: count(STATES.ready),
    },
    labels: { agree, disagree },
  };
}

/** Sum of several reports (the script's "total" row). */
export function sumReports(reports: EvalReport[]) {
  const sum = (f: (r: EvalReport) => number) =>
    reports.reduce((s, r) => s + f(r), 0);
  return {
    diagnoses: reports.length,
    cost_usd: Math.round(sum((r) => r.cost_usd ?? 0) * 100) / 100,
    opportunities: sum((r) => r.opportunities.total),
    with_comparison: sum((r) => r.opportunities.with_comparison),
    cause_like_titles: sum((r) => r.opportunities.cause_like_titles.length),
    hypotheses: sum((r) => r.hypotheses.total),
    with_cited_facts: sum((r) => r.hypotheses.with_cited_facts),
    fact_claims: sum((r) => r.hypotheses.fact_claims),
    fact_claims_grounded: sum((r) => r.hypotheses.fact_claims_grounded),
    refuted: sum((r) => r.hypotheses.refuted),
    inconclusive: sum((r) => r.hypotheses.inconclusive),
    blocked: sum((r) => r.hypotheses.blocked),
    ready: sum((r) => r.hypotheses.ready),
    labels_agree: sum((r) => r.labels.agree.length),
    labels_disagree: sum((r) => r.labels.disagree.length),
  };
}

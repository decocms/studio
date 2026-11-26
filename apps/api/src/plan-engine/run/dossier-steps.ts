/**
 * What becomes of the hypotheses left standing: how many people each change
 * reaches, the test and the priorities, an independent review, and the
 * Before/After this engine does not draw. Each exported async function is one
 * durable step's body; dbos-ux-diagnosis.ts owns the sequence.
 */

import { costTotal, createCostCollector } from "../costs.ts";
import { buildDossier } from "../dossier.ts";
import { designExperiment } from "../experiment.ts";
import { factBook } from "../facts.ts";
import { CURATED_KNOWLEDGE } from "../knowledge/curated.ts";
import type { KnowledgeEntry } from "../knowledge/types.ts";
import {
  advance,
  isNegative,
  type Lifecycle,
  type LifecycleEntry,
  lifecycleOf,
  validationOf,
} from "../lifecycle.ts";
import { isReady, priorityOf, referenceValue } from "../priority.ts";
import { computeRelevance, type HypothesisRelevance } from "../relevance.ts";
import {
  type HypothesisReview,
  PARTIAL_FACTOR,
  reviewDossiers,
} from "../review.ts";
import type {
  DiagnosisEvidence,
  UxHypothesis,
  UxOpportunity,
} from "../types.ts";
import type { EngineRun } from "./engine-run.ts";
import { proposalsInOrder } from "./verify-steps.ts";

/**
 * The lifecycle and validation after relevance. It only moves from a
 * confirmed condition (or an earlier relevance, on "verify again").
 */
export function afterRelevance(
  h: UxHypothesis,
  r: HypothesisRelevance,
  now: string,
) {
  const current = {
    lifecycle: lifecycleOf(h),
    lifecycle_log: h.lifecycle_log ?? [],
  };
  const to =
    r.level === "sem_relevancia" ? "sem_relevancia" : "relevancia_avaliada";
  const next = advance(
    current,
    to,
    `${r.affected_pct}% das visualizações (${r.affected_week}/semana): ${r.level.replace("_", " ")}`,
    now,
  );
  if (!next) return null;
  return { ...next, validation: validationOf(h.verification, r.level) };
}

/** The ones that count: standing, with the condition confirmed. */
export const needsRelevance = (h: UxHypothesis) => {
  const s = lifecycleOf(h);
  return s === "condicao_confirmada" || s === "relevancia_avaliada";
};

/**
 * A hypothesis's test and priorities, and its lifecycle: evaluated relevance
 * → ready when relevant, measurable and on reliable data; ready goes back
 * when it stops being so.
 */
export function planFor(
  h: UxHypothesis,
  o: UxOpportunity,
  evidence: DiagnosisEvidence,
  knowledge: Map<string, KnowledgeEntry>,
  ref: number,
  now: string,
  objective?: string | null,
) {
  const state = lifecycleOf(h);
  const evaluated =
    state === "relevancia_avaliada" || state === "pronta_para_experimento";
  const experiment = evaluated
    ? designExperiment({
        hypothesis: h,
        opportunity: o,
        evidence,
        relevance: h.relevance,
      })
    : null;
  const verdict = evaluated
    ? isReady({ relevance: h.relevance, experiment, opportunity: o })
    : { ready: false, why: "" };
  const priority = priorityOf({
    hypothesis: h,
    opportunity: o,
    relevance: h.relevance,
    experiment,
    evidence,
    knowledge,
    referenceValue: ref,
    ready: verdict.ready,
    objective,
  });
  const current = { lifecycle: state, lifecycle_log: h.lifecycle_log ?? [] };
  const lifecycle =
    verdict.ready && state === "relevancia_avaliada"
      ? advance(current, "pronta_para_experimento", verdict.why, now)
      : !verdict.ready && state === "pronta_para_experimento"
        ? advance(current, "relevancia_avaliada", verdict.why, now)
        : null;
  return {
    experiment,
    priority,
    ...(lifecycle ? { lifecycle } : {}),
    why: verdict.why,
  };
}

/**
 * What the review changes, only downwards: "nao" takes it out of ready (no
 * test priority); "parcial" cuts the test priority by 20%; "sim" keeps it.
 */
export function applyReview(
  h: UxHypothesis,
  r: HypothesisReview,
  now: string,
): {
  priority: NonNullable<UxHypothesis["priority"]> | null;
  lifecycle?: { lifecycle: Lifecycle; lifecycle_log: LifecycleEntry[] };
} {
  const p = h.priority ?? null;
  if (r.explica_o_gap === "nao") {
    const back = advance(
      { lifecycle: lifecycleOf(h), lifecycle_log: h.lifecycle_log ?? [] },
      "relevancia_avaliada",
      `revisor: ${r.resposta.slice(0, 160)}`,
      now,
    );
    return {
      priority: p ? { ...p, teste: null } : null,
      ...(back ? { lifecycle: back } : {}),
    };
  }
  if (r.explica_o_gap === "parcial" && p?.teste != null) {
    return {
      priority: {
        ...p,
        teste: Math.round(p.teste * PARTIAL_FACTOR * 100) / 100,
      },
    };
  }
  return { priority: p };
}

/** The gap left where the Before/After would be: this engine does not draw it. */
export const MOCKUP_OFF = "mockup desligado";

/** The ones ready for a test with no After and no reason recorded. */
export function mockupGapIds(
  opportunities: UxOpportunity[],
  hypotheses: UxHypothesis[],
): string[] {
  return proposalsInOrder(opportunities, hypotheses)
    .filter(
      (h) =>
        lifecycleOf(h) === "pronta_para_experimento" &&
        h.after_url === null &&
        h.after_patch === null &&
        h.mockup_error === null,
    )
    .map((h) => h.id);
}

async function readRound(run: EngineRun) {
  const [diagnosis, opportunities, hypotheses] = await Promise.all([
    run.store.getDiagnosis(run.orgId, run.id),
    run.store.listOpportunities(run.orgId, run.id),
    run.store.listHypotheses(run.orgId, run.id),
  ]);
  return { diagnosis, opportunities, hypotheses };
}

/** Relevance: arithmetic, no model. */
export async function relevanceStep(run: EngineRun): Promise<number> {
  await run.store.updateDiagnosis(run.orgId, run.id, {
    stage: "relevance",
    progress_note: "contando quantas pessoas cada mudança atinge",
  });
  const { diagnosis, opportunities, hypotheses } = await readRound(run);
  const evidence = diagnosis?.evidence;
  if (!evidence) return 0;
  const now = new Date().toISOString();
  for (const h of proposalsInOrder(opportunities, hypotheses)) {
    if (!needsRelevance(h)) continue;
    const r = computeRelevance(h, evidence, now);
    if (!r) continue;
    const patch = afterRelevance(h, r, now);
    if (patch) {
      await run.store.saveHypothesisRelevance(run.orgId, h.id, r, patch);
    }
  }
  return 0;
}

export async function experimentPriorityStep(run: EngineRun): Promise<void> {
  await run.store.updateDiagnosis(run.orgId, run.id, {
    progress_note: "desenhando os testes e as prioridades",
  });
  const [{ diagnosis, opportunities, hypotheses }, knowledge] =
    await Promise.all([
      readRound(run),
      run.knowledge.knowledgeForRun(run.orgId, CURATED_KNOWLEDGE),
    ]);
  const evidence = diagnosis?.evidence;
  if (!evidence) return;
  const byId = new Map(opportunities.map((o) => [o.id, o]));
  const known = new Map(knowledge.entries.map((e) => [e.id, e]));
  const ref = referenceValue(evidence, opportunities);
  const now = new Date().toISOString();
  for (const h of proposalsInOrder(opportunities, hypotheses)) {
    const o = byId.get(h.opportunity_id ?? "");
    if (!o || isNegative(lifecycleOf(h))) continue;
    const plan = planFor(
      h,
      o,
      evidence,
      known,
      ref,
      now,
      diagnosis?.objective_statement,
    );
    await run.store.saveHypothesisPlan(run.orgId, h.id, plan);
  }
}

/** The independent review: reads only the dossier, and only demotes. */
export async function reviewStep(
  run: EngineRun,
  costScope: (scope: string) => string,
): Promise<number> {
  const { diagnosis, opportunities, hypotheses } = await readRound(run);
  const facts = diagnosis?.evidence ? factBook(diagnosis.evidence) : undefined;
  const byId = new Map(opportunities.map((o) => [o.id, o]));
  const ready = proposalsInOrder(opportunities, hypotheses).filter(
    (h) => lifecycleOf(h) === "pronta_para_experimento",
  );
  if (ready.length === 0) return 0;
  await run.store.updateDiagnosis(run.orgId, run.id, {
    progress_note: `revisão independente de ${ready.length} hipótese(s) prontas`,
  });
  const c = createCostCollector(run.id);
  const now = new Date().toISOString();
  let reviews: Map<string, HypothesisReview>;
  try {
    reviews = await reviewDossiers({
      llm: run.llm,
      dossiers: ready.map((h) => ({
        id: h.id,
        markdown: buildDossier({
          hypothesis: h,
          opportunity: byId.get(h.opportunity_id ?? "") ?? null,
          facts,
          objective: diagnosis?.objective_statement,
        }),
      })),
      onUsage: c.llm,
      now,
    });
  } catch (err) {
    const summary = (await run.store.getDiagnosis(run.orgId, run.id))?.summary;
    if (summary) {
      summary.limits.push(
        `A revisão independente não rodou: ${err instanceof Error ? err.message : err}. As prontas seguem como estavam.`,
      );
      await run.store.updateDiagnosis(run.orgId, run.id, { summary });
    }
    reviews = new Map();
  }
  for (const h of ready) {
    const r = reviews.get(h.id);
    if (r) {
      await run.store.saveHypothesisReview(
        run.orgId,
        h.id,
        r,
        applyReview(h, r, now),
      );
    }
  }
  await run.recordCosts(costScope(`ux:${run.id}:review`), c.drafts);
  return costTotal(c);
}

/** The ready ones without an After say why: the mockup is off in this engine. */
export async function mockupOffStep(run: EngineRun): Promise<void> {
  const { opportunities, hypotheses } = await readRound(run);
  for (const hypothesisId of mockupGapIds(opportunities, hypotheses)) {
    await run.store.saveHypothesisMockup(run.orgId, hypothesisId, {
      after_url: null,
      after_patch: null,
      mockup_error: MOCKUP_OFF,
    });
  }
}

export async function finishStep(
  run: EngineRun,
  totalCost: number,
): Promise<void> {
  await run.store.updateDiagnosis(run.orgId, run.id, {
    status: "done",
    stage: "done",
    progress_note: null,
    cost_usd: Math.round(totalCost * 10_000) / 10_000,
    finished: true,
  });
}

/**
 * The first half of a diagnosis: collect → capture → benchmark → probes →
 * opportunities → hypotheses (one step per batch). Each function is the body
 * of one durable step; dbos-ux-diagnosis.ts owns the sequence.
 */

import { orgHeatmap, orgLake } from "../adapters/analytics.ts";
import { orgBigQuery } from "../adapters/bigquery.ts";
import { browserGap, codeAccessFor } from "../adapters/unavailable.ts";
import { MAX_COMPETITORS, normalizeDomain } from "../benchmark.ts";
import { type CaptureCandidate, collectEvidence } from "../collect.ts";
import { costTotal, createCostCollector } from "../costs.ts";
import { buildFacts } from "../facts.ts";
import { CURATED_KNOWLEDGE } from "../knowledge/curated.ts";
import { opportunitiesFromLosses } from "../loss-opportunities.ts";
import {
  fallenLimit,
  fallenReason,
  generateOpportunityHypotheses,
} from "../opportunities.ts";
import { pageSpec } from "../page-types.ts";
import type {
  BenchmarkPdp,
  DiagnosisEvidence,
  OpportunityDraft,
} from "../types.ts";
import type { EngineRun } from "./engine-run.ts";

/** An opportunity left with no hypothesis standing (see fallenReason). */
export interface FallenOpportunity {
  id: string;
  rank: number;
  title: string;
  reason: string;
}

export async function collectStep(
  run: EngineRun,
): Promise<{ targets: CaptureCandidate[]; cost: number }> {
  const { store, orgId, id, ctx } = run;
  await store.updateDiagnosis(orgId, id, {
    stage: "collect",
    progress_note: "lendo GA4, Deco Analytics, pedidos e estoque",
  });
  const [profile, current] = await Promise.all([
    store.getSiteProfile(orgId),
    store.getDiagnosis(orgId, id),
  ]);
  if (!profile) throw new Error("perfil da loja não configurado");
  const costs = createCostCollector(id);
  const result = await collectEvidence({
    profile,
    pageType: current?.page_type ?? "pdp",
    orgSlug: ctx.organization?.slug ?? "",
    heatmap: orgHeatmap(ctx),
    lake: orgLake(orgId),
    bigquery: await orgBigQuery(ctx, orgId),
    vtex: profile.domain ? { publicHost: profile.domain } : null,
    onScan: costs.scan,
  });
  result.evidence.gaps.push(codeAccessFor(profile).gap);
  // Routes read now serve the next runs too.
  if (result.page_templates) {
    await store
      .upsertSiteProfile(orgId, { page_templates: result.page_templates })
      .catch((err) =>
        result.evidence.gaps.push({
          source: "heatmap",
          error: `não gravei as rotas do site no perfil: ${err instanceof Error ? err.message : err}`,
        }),
      );
  }
  await run.recordCosts(`ux:${id}:collect`, costs.drafts);
  const evidence: DiagnosisEvidence = {
    ...result.evidence,
    captures: [],
    benchmark: [],
  };
  await store.updateDiagnosis(orgId, id, { evidence });
  return { targets: result.capture_targets, cost: costTotal(costs) };
}

/** The real pages, in the browser: until Studio has one, the named gap. */
export async function captureStep(run: EngineRun): Promise<number> {
  const { store, orgId, id } = run;
  const diagnosis = await store.getDiagnosis(orgId, id);
  const evidence = diagnosis?.evidence;
  if (!evidence) throw new Error("evidências do collect sumiram");
  const pageType = diagnosis?.page_type ?? "pdp";
  // Cart and checkout belong to the platform: data only.
  if (pageType === "carrinho_checkout") return 0;
  await store.updateDiagnosis(orgId, id, {
    stage: "capture",
    progress_note: `abrindo ${pageType === "pdp" ? "a PDP" : pageSpec(pageType).noun} no celular e no computador`,
  });
  evidence.gaps.push(browserGap());
  await store.updateDiagnosis(orgId, id, { evidence });
  return 0;
}

/**
 * The same pages at competitors. Without a browser only the fresh cached
 * captures come in, and no competitor is suggested.
 */
export async function benchmarkStep(run: EngineRun): Promise<number> {
  const { store, orgId, id } = run;
  await store.updateDiagnosis(orgId, id, {
    stage: "benchmark",
    progress_note: "olhando as mesmas páginas em concorrentes",
  });
  const diagnosis = await store.getDiagnosis(orgId, id);
  const evidence = diagnosis?.evidence;
  const profile = await store.getSiteProfile(orgId);
  if (!evidence || !profile) throw new Error("diagnóstico sem evidências");
  const pageType = diagnosis?.page_type ?? "pdp";
  if (pageType === "carrinho_checkout") return 0;
  const saved = profile.competitors
    .map(normalizeDomain)
    .filter((d): d is string => d !== null);
  const benchmark: BenchmarkPdp[] = [];
  for (const domain of saved) {
    if (benchmark.length >= MAX_COMPETITORS) break;
    const cached = await store.getFreshBenchmark(orgId, domain, pageType);
    if (cached) benchmark.push(cached);
  }
  // Only the PDP rewrites the saved list to the stores that opened.
  const confirmed = profile.competitors_confirmed_at !== null;
  const captured = benchmark.map((b) => b.domain);
  if (
    pageType === "pdp" &&
    !confirmed &&
    captured.length > 0 &&
    captured.join(",") !== saved.join(",")
  ) {
    await store.replaceSuggestedCompetitors(orgId, captured);
  }
  evidence.benchmark = benchmark;
  await store.updateDiagnosis(orgId, id, { evidence });
  return 0;
}

/**
 * What the page does (pop-ups, dead clicks) before any hypothesis. It needs
 * captures and a browser, so it has nothing to do until Studio has one; the
 * step stays so adding the browser does not change the step sequence.
 */
export async function probesStep(_run: EngineRun): Promise<void> {}

export async function opportunitiesStep(run: EngineRun): Promise<{
  ids: string[];
  reserves: OpportunityDraft[];
  cost: number;
}> {
  const { store, orgId, id } = run;
  await store.updateDiagnosis(orgId, id, {
    stage: "opportunities",
    progress_note: "achando as oportunidades da página",
  });
  const diagnosis = await store.getDiagnosis(orgId, id);
  const profile = await store.getSiteProfile(orgId);
  if (!diagnosis?.evidence || !profile) {
    throw new Error("diagnóstico sem evidências");
  }
  // Written once, so a hypothesis's fact ids point at the same facts later.
  const evidence = diagnosis.evidence.facts?.length
    ? diagnosis.evidence
    : { ...diagnosis.evidence, facts: buildFacts(diagnosis.evidence) };
  if (evidence !== diagnosis.evidence) {
    await store.updateDiagnosis(orgId, id, { evidence });
  }
  const result = opportunitiesFromLosses(evidence);
  const saved = await store.replaceOpportunities(
    orgId,
    id,
    result.opportunities,
    [],
  );
  await store.updateDiagnosis(orgId, id, { summary: result.summary });
  return { ids: saved.map((o) => o.id), reserves: result.reserves, cost: 0 };
}

export async function hypothesesStep(
  run: EngineRun,
  batch: string[],
  index: number,
  batches: number,
): Promise<{ cost: number; fallen: FallenOpportunity[] }> {
  const { store, orgId, id } = run;
  await store.updateDiagnosis(orgId, id, {
    stage: "hypotheses",
    progress_note: `hipóteses: lote ${index + 1} de ${batches}`,
  });
  const costs = createCostCollector(id);
  const [diagnosis, opportunities, profile, knowledge] = await Promise.all([
    store.getDiagnosis(orgId, id),
    store.listOpportunities(orgId, id),
    store.getSiteProfile(orgId),
    run.knowledge.knowledgeForRun(orgId, CURATED_KNOWLEDGE),
  ]);
  const evidence = diagnosis?.evidence;
  const mine = opportunities.filter((o) => batch.includes(o.id));
  const fell: FallenOpportunity[] = [];
  if (!evidence || !profile || mine.length === 0) {
    return { cost: 0, fallen: fell };
  }
  const summary = diagnosis?.summary ?? null;
  try {
    const result = await generateOpportunityHypotheses({
      llm: run.llm,
      domain: profile.domain,
      evidence,
      opportunities: mine,
      onUsage: costs.llm,
      knowledge: knowledge.entries,
      objective: diagnosis?.objective_statement,
      mediaUrl: run.mediaUrl,
    });
    for (const o of mine) {
      await store.replaceOpportunityHypotheses(
        orgId,
        id,
        o.id,
        result.byOpportunity.get(o.id) ?? [],
      );
      await store.saveOpportunityTreeNotes(
        orgId,
        o.id,
        result.discarded?.get(o.id) ?? [],
      );
      const reason = fallenReason(result, o.id);
      if (reason) {
        fell.push({ id: o.id, rank: o.rank, title: o.title, reason });
      }
    }
    if (summary) {
      // A fallen opportunity's drops go in its own "Tiramos" line.
      const ofFallen = new Set(
        fell.flatMap((f) => result.droppedBy.get(f.id) ?? []),
      );
      const dropped = result.dropped.filter((d) => !ofFallen.has(d));
      if (dropped.length > 0) {
        summary.limits.push(`Hipóteses que caíram: ${dropped.join("; ")}.`);
      }
      for (const f of fell) summary.limits.push(fallenLimit(f.title, f.reason));
      await store.updateDiagnosis(orgId, id, { summary });
    }
  } catch (err) {
    // A failed batch leaves its opportunities without hypotheses, and says why.
    const message = err instanceof Error ? err.message : String(err);
    if (summary) {
      summary.limits.push(
        `As hipóteses de ${mine.map((o) => `"${o.title}"`).join(", ")} não saíram: ${message}`,
      );
      summary.hypothesis_notes = {
        ...summary.hypothesis_notes,
        ...Object.fromEntries(mine.map((o) => [o.id, message])),
      };
      await store.updateDiagnosis(orgId, id, { summary });
    }
  }
  await run.recordCosts(`ux:${id}:hypotheses:${index + 1}`, costs.drafts);
  return { cost: costTotal(costs), fallen: fell };
}

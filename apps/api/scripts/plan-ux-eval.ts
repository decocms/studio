/**
 * The Plan engine's yardstick over stored diagnoses (`PLAN_UX_DIAGNOSIS_GET`
 * JSON, the whole object): one block per diagnosis and a total, with no model
 * spend. Run it on the rounds before and after a change to see whether the
 * reasoning got better.
 *
 *   bun apps/api/scripts/plan-ux-eval.ts <diagnosis.json>... [--labels <file>] [--json]
 *
 * `--labels` is a JSON array of human verdicts (`EvalLabel` in eval.ts). Keep
 * diagnoses and labels outside the repository: they carry store data.
 *
 * `--replay` also runs the hypotheses step again (writer + critic) on each
 * diagnosis's stored evidence and opportunities, with the code checked out
 * now, and compares it with what the round stored. It spends model money:
 *
 *   OPENROUTER_API_KEY=… PLAN_EVAL_SMART_MODEL=… PLAN_EVAL_THINKING_MODEL=… \
 *     bun apps/api/scripts/plan-ux-eval.ts <diagnosis.json>... --replay [--no-images]
 *
 * The replay uses the curated knowledge only (not the store's entries), and
 * `--no-images` drops the screenshots, whose signed URLs expire.
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { callModel } from "../src/plan-engine/adapters/llm";
import {
  claimMetrics,
  type EvalLabel,
  type EvalReport,
  evaluateDiagnosis,
  evaluateGeneration,
  type GenerationReport,
  repeatedRefutedCauses,
  type StoredDiagnosis,
  sumReports,
} from "../src/plan-engine/eval";
import { factBook, factIndex } from "../src/plan-engine/facts";
import { CURATED_KNOWLEDGE } from "../src/plan-engine/knowledge/curated";
import {
  generateOpportunityHypotheses,
  HYPOTHESES_BATCH,
  type OpportunityHypothesesResult,
} from "../src/plan-engine/opportunities";
import type { Llm, LlmTier } from "../src/plan-engine/ports";
import type { DiagnosisEvidence } from "../src/plan-engine/types";

const USAGE =
  "usage: plan-ux-eval.ts <diagnosis.json>... [--labels <file>] [--json] [--replay [--no-images]]";

const args = process.argv.slice(2);
const files: string[] = [];
let labelsPath: string | null = null;
let asJson = false;
let replay = false;
let images = true;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--labels") labelsPath = args[++i] ?? null;
  else if (a === "--json") asJson = true;
  else if (a === "--replay") replay = true;
  else if (a === "--no-images") images = false;
  else files.push(a);
}
if (files.length === 0) {
  console.error(USAGE);
  process.exit(1);
}

const labels: EvalLabel[] = labelsPath
  ? ((await Bun.file(labelsPath).json()) as EvalLabel[])
  : [];
const diagnoses: StoredDiagnosis[] = [];
for (const f of files) {
  const raw = (await Bun.file(f).json()) as StoredDiagnosis & {
    error?: string;
  };
  if (!raw.diagnosis) {
    console.error(`${f}: not a PLAN_UX_DIAGNOSIS_GET result`);
    process.exit(1);
  }
  diagnoses.push(raw);
}
const reports: EvalReport[] = diagnoses.map((d) =>
  evaluateDiagnosis(d, labels),
);
const repeats = repeatedRefutedCauses(diagnoses);

function replayLlm(): Llm {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const models: Record<LlmTier, string | undefined> = {
    smart: process.env.PLAN_EVAL_SMART_MODEL,
    thinking:
      process.env.PLAN_EVAL_THINKING_MODEL ?? process.env.PLAN_EVAL_SMART_MODEL,
  };
  if (!apiKey || !models.smart) {
    console.error(
      "--replay needs OPENROUTER_API_KEY and PLAN_EVAL_SMART_MODEL (PLAN_EVAL_THINKING_MODEL falls back to it)",
    );
    process.exit(1);
  }
  const openrouter = createOpenRouter({ apiKey });
  return (request, onUsage) => {
    const modelId = models[request.tier]!;
    return callModel(
      {
        languageModel: openrouter.chat(modelId, { usage: { include: true } }),
        provider: "openrouter",
        modelId,
      },
      request,
      onUsage,
    );
  };
}

interface Replay {
  diagnosis_id: string;
  stored: ReturnType<typeof claimMetrics>;
  replayed: GenerationReport | null;
  cost_usd: number;
  error: string | null;
}

const withoutImages = (e: DiagnosisEvidence): DiagnosisEvidence => ({
  ...e,
  captures: e.captures.map((c) => ({ ...c, fold_url: null, full_url: null })),
});

async function replayOne(raw: StoredDiagnosis, llm: Llm): Promise<Replay> {
  const d = raw.diagnosis;
  const stored = (raw.hypotheses ?? []).filter(
    (h) => h.kind === "proposta" && h.opportunity_id,
  );
  // The opportunities the round wrote hypotheses for: the same input, compared.
  const withHypotheses = new Set(stored.map((h) => h.opportunity_id));
  const opportunities = (raw.opportunities ?? []).filter(
    (o) => !o.outcome?.retired && withHypotheses.has(o.id),
  );
  const evidence = d.evidence;
  const out: Replay = {
    diagnosis_id: d.id,
    stored: claimMetrics(
      stored,
      evidence ? factIndex(factBook(evidence)) : new Map(),
    ),
    replayed: null,
    cost_usd: 0,
    error: null,
  };
  if (!evidence || opportunities.length === 0) {
    out.error = "no stored evidence or no opportunity with hypotheses";
    return out;
  }
  const merged: OpportunityHypothesesResult = {
    byOpportunity: new Map(),
    dropped: [],
    droppedBy: new Map(),
  };
  try {
    for (let i = 0; i < opportunities.length; i += HYPOTHESES_BATCH) {
      const result = await generateOpportunityHypotheses({
        llm,
        domain: d.domain ?? "",
        evidence: images ? evidence : withoutImages(evidence),
        opportunities: opportunities.slice(i, i + HYPOTHESES_BATCH),
        knowledge: CURATED_KNOWLEDGE,
        onUsage: (u) => {
          out.cost_usd += u.costUsd ?? 0;
        },
      });
      for (const [k, v] of result.byOpportunity) merged.byOpportunity.set(k, v);
      for (const [k, v] of result.droppedBy) merged.droppedBy.set(k, v);
      merged.dropped.push(...result.dropped);
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    return out;
  }
  out.replayed = evaluateGeneration(
    merged,
    opportunities.map((o) => o.id),
    evidence,
  );
  return out;
}

const replays: Replay[] = [];
if (replay) {
  const llm = replayLlm();
  for (const d of diagnoses) replays.push(await replayOne(d, llm));
}

if (asJson) {
  console.log(
    JSON.stringify(
      { reports, total: sumReports(reports), repeats, replays },
      null,
      2,
    ),
  );
  process.exit(0);
}

const pct = (a: number, b: number) =>
  b > 0 ? `${Math.round((a / b) * 100)}%` : "-";
const cats = (c: Record<string, number>) =>
  Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ") || "none";

for (const r of reports) {
  const o = r.opportunities;
  const h = r.hypotheses;
  console.log(
    `\n# ${r.diagnosis_id.slice(0, 8)} (${r.page_type}): US$ ${r.cost_usd ?? "?"}, ${r.minutes ?? "?"} min`,
  );
  console.log(
    `- opportunities: ${o.total}, with a comparison ${o.with_comparison} (${pct(o.with_comparison, o.total)})${o.cause_like_titles.length > 0 ? `; title that reads as a cause: ${o.cause_like_titles.map((t) => `"${t}"`).join("; ")}` : ""}`,
  );
  console.log(
    `- today's code builds ${o.today.total} from the same evidence: ${o.today.titles.map((t) => `"${t}"`).join("; ") || "none"}`,
  );
  console.log(
    `- hypotheses: ${h.total}; cite a fact ${h.with_cited_facts} (${pct(h.with_cited_facts, h.total)}); grounded "fato" ${h.fact_claims_grounded}/${h.fact_claims}; refuted ${h.refuted}, inconclusive ${h.inconclusive}, blocked ${h.blocked}, ready ${h.ready}`,
  );
  console.log(`- categories: ${cats(h.categories)}`);
  for (const a of r.labels.agree) console.log(`  ✓ label: ${a}`);
  for (const x of r.labels.disagree) console.log(`  ✗ label: ${x}`);
}

const t = sumReports(reports);
console.log(`\n# Total (${t.diagnoses} diagnoses, US$ ${t.cost_usd})`);
console.log(
  `- opportunities with a comparison: ${t.with_comparison}/${t.opportunities} (${pct(t.with_comparison, t.opportunities)}); title that reads as a cause: ${t.cause_like_titles}`,
);
console.log(
  `- hypotheses citing a fact: ${t.with_cited_facts}/${t.hypotheses} (${pct(t.with_cited_facts, t.hypotheses)}); grounded "fato": ${t.fact_claims_grounded}/${t.fact_claims} (${pct(t.fact_claims_grounded, t.fact_claims)})`,
);
console.log(
  `- refuted ${t.refuted} (${pct(t.refuted, t.hypotheses)}), inconclusive ${t.inconclusive}, blocked ${t.blocked}, ready ${t.ready} (${pct(t.ready, t.hypotheses)})`,
);
console.log(`- categories: ${cats(t.categories)}`);
console.log(
  `- human labels: ${t.labels_agree} agree, ${t.labels_disagree} disagree`,
);
console.log(
  `- causes proposed again after an earlier round refuted them: ${repeats.length}`,
);
for (const r of repeats) {
  console.log(
    `  ↺ ${r.diagnosis_id.slice(0, 8)}: "${r.title}" (refuted in ${r.refuted_in.slice(0, 8)})`,
  );
}

if (replays.length > 0) {
  console.log("\n# Replay of the hypotheses step (stored → replayed)");
  for (const r of replays) {
    const s = r.stored;
    const p = r.replayed;
    if (!p) {
      console.log(`- ${r.diagnosis_id.slice(0, 8)}: not replayed (${r.error})`);
      continue;
    }
    console.log(
      `- ${r.diagnosis_id.slice(0, 8)}: hypotheses ${s.total} → ${p.total} (dropped ${p.dropped}, empty opportunities ${p.empty_opportunities}); cite a fact ${pct(s.with_cited_facts, s.total)} → ${pct(p.with_cited_facts, p.total)}; grounded "fato" ${pct(s.fact_claims_grounded, s.fact_claims)} → ${pct(p.fact_claims_grounded, p.fact_claims)}; US$ ${r.cost_usd.toFixed(2)}`,
    );
    console.log(
      `    categories: ${cats(s.categories)} → ${cats(p.categories)}`,
    );
  }
}

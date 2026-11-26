/**
 * Verification: each proposal is planned, tested on the live page and in the
 * code, and judged; then the opportunities verification emptied get another
 * round, the reserves try their place, and each opportunity says why its
 * investigation stopped. Each exported async function is one durable step's
 * body; dbos-ux-diagnosis.ts owns the sequence.
 */

import { type DiagnosisPatch, retiredId } from "@/storage/plan-engine";
import { codeAccessFor } from "../adapters/repo.ts";
import {
  type CostCollector,
  costTotal,
  createCostCollector,
} from "../costs.ts";
import { isDataCheckable, trafficCheck } from "../data-checks.ts";
import { appendFacts, factBook } from "../facts.ts";
import { CURATED_KNOWLEDGE } from "../knowledge/curated.ts";
import { fromVerification } from "../knowledge/learn.ts";
import { pageSignature } from "../knowledge/validity.ts";
import {
  advance,
  isNegative,
  lifecycleFromVerification,
  lifecycleOf,
  stopReasonOf,
  validationOf,
} from "../lifecycle.ts";
import {
  fallenLimit,
  fallenReason,
  generateOpportunityHypotheses,
  reservesLimit,
} from "../opportunities.ts";
import { triedLines, verdictFacts } from "../reinvestigate.ts";
import type {
  DiagnosisEvidence,
  DiagnosisSummary,
  OpportunityDraft,
  UxHypothesis,
  UxOpportunity,
} from "../types.ts";
import { lazyCodeReader } from "../verify/code-source.ts";
import {
  liveDeps,
  planJudgeDeps,
  repoDeps,
  type VerifyDeps,
  verificationBase,
  verifyHypothesis,
} from "../verify/index.ts";
import { elementKeysOf } from "../verify/plan.ts";
import {
  loadRepoSnapshot,
  type RepoSnapshot,
  repoSnapshotKey,
} from "../verify/repo.ts";
import { withRepoSnapshot } from "../verify/repo-snapshot.ts";
import type { RepoReader } from "../ports.ts";
import type {
  CheckRun,
  HypothesisVerification,
  VerifyCheck,
} from "../verify/types.ts";
import type { FallenOpportunity } from "./diagnosis-steps.ts";
import type { EngineRun } from "./engine-run.ts";

/** A proposal verification refuted (it stays, as refuted). */
export interface DroppedHypothesis {
  opportunityId: string;
  title: string;
  reason: string;
}

const NO_REASON = "nenhuma hipótese sobrou depois da verificação";

/**
 * Until when a hypothesis's test may START, from the step's start: room is
 * left for the test in flight, the judge and the write.
 */
const VERIFY_BUDGET_MS = 10 * 60_000;

/**
 * A hypothesis's deadline among `remaining` still to run in the same step:
 * what is left until `stepDeadline`, split evenly, recomputed each time.
 */
export function hypothesisDeadline(
  stepDeadline: number,
  now: number,
  remaining: number,
): number {
  return now + Math.max(0, stepDeadline - now) / Math.max(1, remaining);
}

/** A failed "verify again" puts a finished diagnosis back to done, with the failure in its limits. */
export function rerunFailedPatch(
  summary: DiagnosisSummary | null,
  message: string,
): DiagnosisPatch {
  return {
    status: "done",
    stage: "done",
    progress_note: null,
    finished: true,
    ...(summary
      ? {
          summary: {
            ...summary,
            limits: [
              ...summary.limits,
              `A verificação de novo falhou: ${message}`,
            ],
          },
        }
      : {}),
  };
}

/** The limits line with the refuted hypotheses. */
function refutedLine(dropped: DroppedHypothesis[]): string | null {
  return dropped.length > 0
    ? `A verificação desmentiu: ${dropped.map((d) => `"${d.title}" (${d.reason})`).join("; ")}.`
    : null;
}

async function readRound(run: EngineRun) {
  const [diagnosis, opportunities, hypotheses] = await Promise.all([
    run.store.getDiagnosis(run.orgId, run.id),
    run.store.listOpportunities(run.orgId, run.id),
    run.store.listHypotheses(run.orgId, run.id),
  ]);
  return { diagnosis, opportunities, hypotheses };
}

/**
 * Opportunities left with no proposal standing. One with an error note in
 * `hypothesis_notes` stays: its hypotheses never came, verification did not
 * refute them.
 */
export function fallenAfterVerify(
  opportunities: UxOpportunity[],
  hypotheses: UxHypothesis[],
  dropReasons: Map<string, string[]>,
  notes: Record<string, string>,
): FallenOpportunity[] {
  const standing = new Set(
    hypotheses
      .filter(
        (h) =>
          h.kind === "proposta" &&
          h.opportunity_id !== null &&
          !isNegative(lifecycleOf(h)),
      )
      .map((h) => h.opportunity_id),
  );
  return opportunities
    .filter((o) => !o.outcome?.retired && !standing.has(o.id) && !notes[o.id])
    .map((o) => ({
      id: o.id,
      rank: o.rank,
      title: o.title,
      reason: (dropReasons.get(o.id) ?? []).join("; ") || NO_REASON,
    }));
}

/** The proposals in screen order: the opportunity's rank, then the hypothesis's. */
export function proposalsInOrder(
  opportunities: UxOpportunity[],
  hypotheses: UxHypothesis[],
): UxHypothesis[] {
  const rankOf = new Map(
    opportunities.filter((o) => !o.outcome?.retired).map((o) => [o.id, o.rank]),
  );
  return hypotheses
    .filter(
      (h) =>
        h.kind === "proposta" &&
        h.opportunity_id !== null &&
        rankOf.has(h.opportunity_id),
    )
    .sort(
      (a, b) =>
        (rankOf.get(a.opportunity_id ?? "") ?? 0) -
          (rankOf.get(b.opportunity_id ?? "") ?? 0) || a.rank - b.rank,
    );
}

/** How many hypotheses of each opportunity a round investigates; the rest keep the Verify button. */
const MAX_VERIFIED_PER_OPPORTUNITY = 2;

/**
 * The ones verification investigates this round: per opportunity, those with
 * something to check on the page, most confident first, up to
 * MAX_VERIFIED_PER_OPPORTUNITY, in screen order.
 */
export function toInvestigate(proposals: UxHypothesis[]): UxHypothesis[] {
  const keep = new Set<string>();
  const byOpportunity = new Map<string, UxHypothesis[]>();
  for (const h of proposals) {
    if (h.tree?.testavel_na_pagina === false) continue;
    if (isNegative(lifecycleOf(h))) continue;
    const key = h.opportunity_id ?? "";
    byOpportunity.set(key, [...(byOpportunity.get(key) ?? []), h]);
  }
  for (const list of byOpportunity.values()) {
    for (const h of [...list]
      .sort((a, b) => b.confidence - a.confidence || a.rank - b.rank)
      .slice(0, MAX_VERIFIED_PER_OPPORTUNITY)) {
      keep.add(h.id);
    }
  }
  return proposals.filter((h) => keep.has(h.id));
}

/**
 * Prefix of a round's verification media. A "verify again" writes under its
 * own tag, so the screen never keeps showing the first round's capture.
 */
export const verifyKeyPrefix = (
  diagnosisId: string,
  runTag: string | undefined,
  hypothesisId: string,
) =>
  `${runTag ? `ux/${diagnosisId}/${runTag}` : `ux/${diagnosisId}`}/verify/${hypothesisId}`;

const notTested = (check: VerifyCheck, why: string): CheckRun => ({
  check,
  outcome: "nao_testou",
  observed: why,
  screenshot_url: null,
  source_ref: null,
});

/**
 * The live tests in the run's browser, opened on the first one: a hypothesis
 * with nothing to test on the page provisions nothing.
 */
function liveChecks(
  run: EngineRun,
  evidence: DiagnosisEvidence,
  hypothesisId: string,
): VerifyDeps["live"] {
  const elementKeys = [...elementKeysOf(evidence)];
  const keyPrefix = verifyKeyPrefix(run.id, run.runTag, hypothesisId);
  return async (check) => {
    const browser = await run.browser();
    if ("gap" in browser) return notTested(check, browser.gap.error);
    return liveDeps({
      browser: browser.port,
      captures: evidence.captures,
      elementKeys,
      media: browser.media,
      keyPrefix,
    }).live(check);
  };
}

/** The store's code for the code tests: the round's snapshot, and the repo for a file it lacks. */
interface RunCode {
  snapshot: RepoSnapshot | null;
  read: RepoReader | undefined;
}

/** Read once per step: the snapshot from the run's media, the repo opened on the first file asked for. */
async function runCode(
  run: EngineRun,
  evidence: DiagnosisEvidence,
): Promise<RunCode> {
  const key = evidence.repo_snapshot_key;
  const [snapshot, profile] = await Promise.all([
    run.media && key ? loadRepoSnapshot(run.media, key) : null,
    run.store.getSiteProfile(run.orgId),
  ]);
  return {
    snapshot,
    read: lazyCodeReader(codeAccessFor(run.ctx, run.orgId, profile)),
  };
}

/**
 * Verifies one hypothesis and writes the outcome: keeps it (with the
 * verification and the new confidence), rewrites it, or marks it refuted. A
 * failure becomes an "inconclusiva" verification with the reason.
 */
async function verifyAndApply(opts: {
  run: EngineRun;
  h: UxHypothesis;
  opportunity: UxOpportunity;
  evidence: DiagnosisEvidence;
  code: RunCode;
  onUsage: CostCollector["llm"];
  /** Until when a test may start (ms epoch). */
  deadline: number;
}): Promise<DroppedHypothesis | null> {
  const { run, h, opportunity, evidence } = opts;
  const { store, orgId } = run;
  const timeLeft = () => opts.deadline - Date.now();
  const deps: VerifyDeps = {
    ...planJudgeDeps({
      llm: run.llm,
      opportunity,
      evidence,
      onUsage: opts.onUsage,
    }),
    ...repoDeps({
      llm: run.llm,
      snapshot: opts.code.snapshot,
      ctx: { elementKeys: elementKeysOf(evidence) },
      onUsage: opts.onUsage,
      read: opts.code.read,
      timeLeft,
    }),
    live: liveChecks(run, evidence, h.id),
    now: () => new Date().toISOString(),
    timeLeft,
    // The judge does not swap the cause: what it saw comes back as a fact.
    allowRewrite: false,
  };
  try {
    const startedAt = new Date().toISOString();
    const outcome = await verifyHypothesis(h, deps);
    await learnFromVerdict(run, h, opportunity, evidence, outcome.verification);
    if (outcome.kind === "keep") {
      await store.saveHypothesisVerification(
        orgId,
        h.id,
        outcome.verification,
        outcome.confidence,
      );
      await applyLifecycle(run, h, outcome.verification, startedAt);
      return null;
    }
    if (outcome.kind === "rewrite") {
      const d = outcome.draft;
      await store.rewriteHypothesis(
        orgId,
        h.id,
        {
          title: d.title,
          why: d.why,
          evidence_md: `${d.evidence_md}\n\n**Se for isso:** ${d.prediction}`,
          idea: d.idea,
          where: d.where,
          confidence: outcome.confidence,
        },
        outcome.verification,
      );
      await applyLifecycle(run, h, outcome.verification, startedAt);
      return null;
    }
    // A refuted one stays, with the proof, and leaves the count as refuted.
    await store.saveHypothesisVerification(
      orgId,
      h.id,
      outcome.verification,
      h.confidence,
    );
    await applyLifecycle(run, h, outcome.verification, startedAt);
    return {
      opportunityId: opportunity.id,
      title: h.title,
      reason: outcome.reason,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[plan-engine] verification of ${h.id}: ${message}`);
    const base = verificationBase(h);
    await store
      .saveHypothesisVerification(
        orgId,
        h.id,
        {
          verdict: "inconclusiva",
          summary: `a verificação falhou: ${message}`,
          runs: [],
          rewritten_from: base.rewrittenFrom,
          verified_at: new Date().toISOString(),
          base_confidence: base.confidence,
        },
        h.confidence,
      )
      .catch(() => {});
    return null;
  }
}

/** The verdict moves the hypothesis through its lifecycle; failing here keeps the verdict. */
async function applyLifecycle(
  run: EngineRun,
  h: UxHypothesis,
  verification: HypothesisVerification,
  startedAt: string,
): Promise<void> {
  const current = {
    lifecycle: lifecycleOf(h),
    lifecycle_log: h.lifecycle_log ?? [],
  };
  const investigating =
    advance(current, "em_investigacao", "verificação começou", startedAt) ??
    current;
  const next = advance(
    investigating,
    lifecycleFromVerification(verification),
    verification.summary.slice(0, 200),
    new Date().toISOString(),
  );
  if (!next) return;
  try {
    await run.store.saveHypothesisLifecycle(run.orgId, h.id, {
      ...next,
      validation: validationOf(verification),
    });
  } catch (err) {
    console.warn(
      `[plan-engine] lifecycle of ${h.id} not saved: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** The verdict becomes the store's knowledge, read before the next analysis writes. */
async function learnFromVerdict(
  run: EngineRun,
  h: UxHypothesis,
  opportunity: UxOpportunity,
  /** null: a verdict that does not depend on the page (traffic, by segments). */
  evidence: DiagnosisEvidence | null,
  verification: HypothesisVerification,
): Promise<void> {
  const captures = evidence?.captures ?? [];
  const draft = fromVerification({
    hypothesis: h,
    area: opportunity.area,
    verification,
    pageUrl:
      captures.find((c) => c.device === h.device)?.url ??
      captures[0]?.url ??
      null,
    signature: evidence
      ? pageSignature(evidence, h.device === "desktop" ? "desktop" : "mobile")
      : null,
  });
  if (!draft) return;
  try {
    await run.knowledge.upsertKnowledge(run.orgId, draft);
  } catch (err) {
    console.warn(
      `[plan-engine] verdict of ${h.id} not learned: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** The store's code for the code tests; without a path to it, the owned gap. */
export async function repoSnapshotStep(run: EngineRun): Promise<void> {
  const { store, orgId, id } = run;
  // A storage hiccup here does not stop verification: code tests read "not tested".
  try {
    const [diagnosis, profile] = await Promise.all([
      store.getDiagnosis(orgId, id),
      store.getSiteProfile(orgId),
    ]);
    const evidence = diagnosis?.evidence;
    if (!evidence) return;
    // Cart and checkout are the platform's: no site section to read.
    if (diagnosis?.page_type === "carrinho_checkout") return;
    await store.updateDiagnosis(orgId, id, {
      stage: "verify",
      progress_note: "lendo o código da loja",
    });
    const next = await withRepoSnapshot({
      evidence,
      access: codeAccessFor(run.ctx, orgId, profile),
      media: run.media,
      key: repoSnapshotKey(id),
    });
    await store.updateDiagnosis(orgId, id, { evidence: next });
  } catch (err) {
    console.warn(
      `[plan-engine] [${id}] repo-snapshot: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** The proposals to verify, read once so a replay asks for the same ids. */
export async function verifyListStep(
  run: EngineRun,
  only: string[] | undefined,
): Promise<string[]> {
  const { opportunities, hypotheses } = await readRound(run);
  const proposals = proposalsInOrder(opportunities, hypotheses);
  const picked = only
    ? proposals.filter((h) => only.includes(h.id))
    : toInvestigate(proposals);
  return picked.map((h) => h.id);
}

export async function verifyStep(
  run: EngineRun,
  hypothesisId: string,
  index: number,
  total: number,
  costScope: (scope: string) => string,
): Promise<{ cost: number; dropped: DroppedHypothesis | null }> {
  const deadline = Date.now() + VERIFY_BUDGET_MS;
  const { store, orgId, id } = run;
  const c = createCostCollector(id);
  let round: Awaited<ReturnType<typeof readRound>>;
  // A read failure before spending anything leaves the hypothesis as it was.
  try {
    await store.updateDiagnosis(orgId, id, {
      stage: "verify",
      progress_note: `verificando a hipótese ${index + 1} de ${total}`,
    });
    round = await readRound(run);
  } catch (err) {
    console.warn(
      `[plan-engine] [${id}] verify:${hypothesisId} not read: ${err instanceof Error ? err.message : err}`,
    );
    return { cost: 0, dropped: null };
  }
  const h = round.hypotheses.find((x) => x.id === hypothesisId);
  const opportunity = round.opportunities.find(
    (o) => o.id === h?.opportunity_id,
  );
  const evidence = round.diagnosis?.evidence;
  if (!h || !opportunity || !evidence) return { cost: 0, dropped: null };
  const gone = await verifyAndApply({
    run,
    h,
    opportunity,
    evidence,
    code: await runCode(run, evidence),
    onUsage: c.llm,
    deadline,
  });
  await run.recordCosts(costScope(`ux:${id}:verify:${hypothesisId}`), c.drafts);
  return { cost: costTotal(c), dropped: gone };
}

/** Traffic explanations, decided by the segments, without a browser. */
export async function dataChecksStep(
  run: EngineRun,
  only: string[] | undefined,
): Promise<DroppedHypothesis[]> {
  const { opportunities, hypotheses, diagnosis } = await readRound(run);
  const segments = diagnosis?.evidence?.segments;
  const byId = new Map(opportunities.map((o) => [o.id, o]));
  const out: DroppedHypothesis[] = [];
  for (const h of proposalsInOrder(opportunities, hypotheses)) {
    if (!isDataCheckable(h) || (only && !only.includes(h.id))) continue;
    const o = byId.get(h.opportunity_id ?? "");
    if (!o) continue;
    const startedAt = new Date().toISOString();
    const v = trafficCheck(h, o, startedAt, segments);
    await run.store.saveHypothesisVerification(
      run.orgId,
      h.id,
      v,
      h.confidence,
    );
    await applyLifecycle(run, h, v, startedAt);
    await learnFromVerdict(run, h, o, null, v);
    if (v.verdict === "desmentida") {
      out.push({ opportunityId: o.id, title: h.title, reason: v.summary });
    }
  }
  return out;
}

export async function verifyFallenStep(
  run: EngineRun,
  prior: FallenOpportunity[],
  dropped: DroppedHypothesis[],
): Promise<FallenOpportunity[]> {
  const dropReasons = new Map<string, string[]>();
  for (const d of dropped) {
    dropReasons.set(d.opportunityId, [
      ...(dropReasons.get(d.opportunityId) ?? []),
      d.reason,
    ]);
  }
  const { diagnosis, opportunities, hypotheses } = await readRound(run);
  const summary = diagnosis?.summary ?? null;
  const known = new Set(prior.map((f) => f.id));
  const fell = fallenAfterVerify(
    opportunities,
    hypotheses,
    dropReasons,
    summary?.hypothesis_notes ?? {},
  ).filter((f) => !known.has(f.id));
  if (summary) {
    // The fallen opportunity's refutations go in its "Tiramos" line instead.
    const fellIds = new Set(fell.map((f) => f.id));
    const refuted = refutedLine(
      dropped.filter((d) => !fellIds.has(d.opportunityId)),
    );
    if (refuted) {
      summary.limits.push(refuted);
      await run.store.updateDiagnosis(run.orgId, run.id, { summary });
    }
  }
  return fell;
}

/**
 * A new round of hypotheses for an opportunity verification emptied: the
 * refuted ones become facts and "already tried", and the new ones go through
 * triage and the verifier. `found` = one of them is still standing.
 */
export async function reinvestigateStep(
  run: EngineRun,
  f: FallenOpportunity,
  costScope: (scope: string) => string,
): Promise<{ found: boolean; cost: number; reason: string | null }> {
  const { store, orgId, id } = run;
  const c = createCostCollector(id);
  const stepDeadline = Date.now() + VERIFY_BUDGET_MS;
  const [diagnosis, opportunities, hypotheses, profile, knowledge] =
    await Promise.all([
      store.getDiagnosis(orgId, id),
      store.listOpportunities(orgId, id),
      store.listHypotheses(orgId, id),
      store.getSiteProfile(orgId),
      run.knowledge.knowledgeForRun(orgId, CURATED_KNOWLEDGE),
    ]);
  const o = opportunities.find((x) => x.id === f.id);
  const evidence0 = diagnosis?.evidence;
  if (!o || !evidence0 || !profile) {
    return { found: false, cost: 0, reason: null };
  }
  await store.updateDiagnosis(orgId, id, {
    stage: "verify",
    progress_note: `procurando outra causa pra "${o.title}"`,
  });
  const mine = hypotheses.filter((h) => h.opportunity_id === o.id);
  const learned = verdictFacts(mine);
  const evidence =
    learned.length > 0
      ? { ...evidence0, facts: appendFacts(factBook(evidence0), learned) }
      : evidence0;
  if (evidence !== evidence0) {
    await store.updateDiagnosis(orgId, id, { evidence });
  }
  let found = false;
  let reason: string | null = null;
  try {
    const result = await generateOpportunityHypotheses({
      llm: run.llm,
      domain: profile.domain,
      evidence,
      opportunities: [o],
      onUsage: c.llm,
      knowledge: knowledge.entries,
      tried: new Map([[o.id, triedLines(mine)]]),
      objective: diagnosis?.objective_statement,
      mediaUrl: run.mediaUrl,
    });
    const drafts = result.byOpportunity.get(o.id) ?? [];
    if (drafts.length === 0) {
      reason = `${f.reason}; a rodada nova não achou outra causa (${fallenReason(result, o.id)})`;
    } else {
      const ids = await store.appendOpportunityHypotheses(
        orgId,
        id,
        o.id,
        drafts,
      );
      const code = await runCode(run, evidence);
      const fresh = toInvestigate(
        proposalsInOrder([o], await store.listHypotheses(orgId, id)).filter(
          (h) => ids.includes(h.id),
        ),
      );
      const gone: DroppedHypothesis[] = [];
      for (const [i, h] of fresh.entries()) {
        const d = await verifyAndApply({
          run,
          h,
          opportunity: o,
          evidence,
          code,
          onUsage: c.llm,
          deadline: hypothesisDeadline(
            stepDeadline,
            Date.now(),
            fresh.length - i,
          ),
        });
        if (d) gone.push(d);
      }
      // Standing = one of the new ones did not fall, investigated or not.
      found = gone.length < ids.length;
      reason = found
        ? null
        : `${f.reason}; a rodada nova também caiu (${gone.map((d) => d.reason).join("; ")})`;
      const summary = (await store.getDiagnosis(orgId, id))?.summary;
      if (summary && found) {
        summary.limits.push(
          `"${o.title}": as primeiras causas caíram na verificação, e uma rodada nova, com o que a verificação viu, achou outra.`,
        );
        await store.updateDiagnosis(orgId, id, { summary });
      }
    }
  } catch (err) {
    reason = `${f.reason}; a rodada nova falhou (${err instanceof Error ? err.message : err})`;
  }
  await run.recordCosts(
    costScope(`ux:${id}:reinvestigate:${f.rank}`),
    c.drafts,
  );
  return { found, cost: costTotal(c), reason };
}

/** Appends lines to the diagnosis's limits, when it has a summary. */
export async function limitsStep(
  run: EngineRun,
  lines: string[],
): Promise<void> {
  if (lines.length === 0) return;
  const summary = (await run.store.getDiagnosis(run.orgId, run.id))?.summary;
  if (!summary) return;
  summary.limits.push(...lines);
  await run.store.updateDiagnosis(run.orgId, run.id, { summary });
}

export const fallenLines = (fallen: FallenOpportunity[]) =>
  fallen.map((f) => fallenLimit(f.title, f.reason));

export async function retireStep(
  run: EngineRun,
  f: FallenOpportunity,
): Promise<void> {
  await run.store.retireOpportunity(run.orgId, f, {
    stop: "todas_descartadas",
    retired: true,
    note: f.reason,
  });
}

/**
 * A reserve tries a fallen opportunity's place; it counts only if one of its
 * hypotheses survives the same verifier as the ones on screen.
 */
export async function replaceStep(
  run: EngineRun,
  f: FallenOpportunity,
  reserve: OpportunityDraft,
  attempt: number,
  costScope: (scope: string) => string,
): Promise<{ cost: number; filled: boolean }> {
  const stepDeadline = Date.now() + VERIFY_BUDGET_MS;
  const { store, orgId, id } = run;
  // Stays in "verify": the stepper must not go back to "hypotheses".
  await store.updateDiagnosis(orgId, id, {
    stage: "verify",
    progress_note: `trocando "${f.title}", que não parou de pé`,
  });
  const c = createCostCollector(id);
  const [diagnosis, profile, knowledge] = await Promise.all([
    store.getDiagnosis(orgId, id),
    store.getSiteProfile(orgId),
    run.knowledge.knowledgeForRun(orgId, CURATED_KNOWLEDGE),
  ]);
  const evidence = diagnosis?.evidence;
  if (!evidence || !profile) return { cost: 0, filled: false };
  const saved = await store.putOpportunityAt(orgId, id, reserve);
  let line: string;
  let ok = false;
  try {
    const result = await generateOpportunityHypotheses({
      llm: run.llm,
      domain: profile.domain,
      evidence,
      opportunities: [saved],
      onUsage: c.llm,
      knowledge: knowledge.entries,
      objective: diagnosis?.objective_statement,
      mediaUrl: run.mediaUrl,
    });
    const reason = fallenReason(result, saved.id);
    if (reason) {
      line = fallenLimit(saved.title, reason);
    } else {
      await store.replaceOpportunityHypotheses(
        orgId,
        id,
        saved.id,
        result.byOpportunity.get(saved.id) ?? [],
      );
      await store.saveOpportunityTreeNotes(
        orgId,
        saved.id,
        result.discarded?.get(saved.id) ?? [],
      );
      await store.updateDiagnosis(orgId, id, {
        stage: "verify",
        progress_note: `verificando "${saved.title}", que entra no lugar de "${f.title}"`,
      });
      const code = await runCode(run, evidence);
      const all = proposalsInOrder(
        [saved],
        await store.listHypotheses(orgId, id),
      );
      const fresh = toInvestigate(all);
      const gone: DroppedHypothesis[] = [];
      for (const [i, h] of fresh.entries()) {
        const d = await verifyAndApply({
          run,
          h,
          opportunity: saved,
          evidence,
          code,
          onUsage: c.llm,
          deadline: hypothesisDeadline(
            stepDeadline,
            Date.now(),
            fresh.length - i,
          ),
        });
        if (d) gone.push(d);
      }
      if (gone.length === all.length) {
        const why = gone.map((d) => d.reason).join("; ") || NO_REASON;
        line = fallenLimit(saved.title, why);
        await store.retireOpportunity(
          orgId,
          saved,
          { stop: "todas_descartadas", retired: true, note: why },
          retiredId(f.id, attempt),
        );
      } else {
        line = [
          `"${saved.title}" entrou no lugar de "${f.title}".`,
          refutedLine(gone),
        ]
          .filter(Boolean)
          .join(" ");
        ok = true;
      }
    }
  } catch (err) {
    line = `"${saved.title}" não entrou no lugar de "${f.title}": as hipóteses não saíram (${err instanceof Error ? err.message : err}).`;
  }
  // Read again: verification above wrote to the summary since the step began.
  await limitsStep(run, [line]);
  await run.recordCosts(
    costScope(`ux:${id}:replace:${f.rank}:${attempt}`),
    c.drafts,
  );
  return { cost: costTotal(c), filled: ok };
}

/** With no reserve standing, the place stays empty and whatever is left in it retires. */
export async function dropStep(
  run: EngineRun,
  f: FallenOpportunity,
): Promise<void> {
  const left = (await run.store.listOpportunities(run.orgId, run.id)).find(
    (o) => o.id === f.id,
  );
  if (!left) return;
  await run.store.retireOpportunity(
    run.orgId,
    left,
    {
      stop: "todas_descartadas",
      retired: true,
      note: "nenhuma hipótese que estes dados sustentem",
    },
    retiredId(f.id, 99),
  );
}

export const reservesLines = (left: OpportunityDraft[]) => {
  const line = reservesLimit(left);
  return line ? [line] : [];
};

/** Why each opportunity's investigation stopped. */
export async function outcomesStep(run: EngineRun): Promise<void> {
  const [opportunities, hypotheses] = await Promise.all([
    run.store.listOpportunities(run.orgId, run.id),
    run.store.listHypotheses(run.orgId, run.id),
  ]);
  for (const o of opportunities) {
    if (o.outcome?.retired) continue;
    const mine = hypotheses.filter(
      (h) => h.opportunity_id === o.id && h.kind === "proposta",
    );
    await run.store.saveOpportunityOutcome(
      run.orgId,
      o.id,
      stopReasonOf(o, mine),
    );
  }
}

/** A failed run becomes an error; a failed "verify again" goes back to done. */
export async function failStep(
  run: EngineRun,
  rerun: boolean,
  message: string,
): Promise<void> {
  await run.releaseBrowser();
  if (rerun) {
    const summary =
      (await run.store.getDiagnosis(run.orgId, run.id))?.summary ?? null;
    await run.store.updateDiagnosis(
      run.orgId,
      run.id,
      rerunFailedPatch(summary, message),
    );
    return;
  }
  await run.store.updateDiagnosis(run.orgId, run.id, {
    status: "error",
    error: message,
    finished: true,
  });
}

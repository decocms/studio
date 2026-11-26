/**
 * Verifies ONE hypothesis: plan → repo tests (their `followup` joins the browser queue) → live tests → verdict.
 * Everything comes through `VerifyDeps`, so ordering and outcome rules test without network or Chrome.
 */

import { type Llm, type LlmUsage, rethrowNoAiModel } from "../ports.ts";
import type {
  DiagnosisEvidence,
  UxHypothesis,
  UxOpportunity,
} from "../types.ts";
import { type ParsedPlan, planVerification } from "./plan.ts";
import type { CheckRun, HypothesisVerification, VerifyCheck } from "./types.ts";
import {
  CONFIRM_BOOST,
  CONFIRM_CEILING,
  type JudgeResult,
  judgeVerification,
  type RewriteDraft,
  scrollForPrompt,
} from "./verdict.ts";

export interface VerifyDeps {
  plan: (h: UxHypothesis) => Promise<ParsedPlan>;
  live: (check: VerifyCheck) => Promise<CheckRun>;
  repo: (
    check: VerifyCheck,
    h: UxHypothesis,
  ) => Promise<{ run: CheckRun; followup: VerifyCheck | null }>;
  judge: (
    h: UxHypothesis,
    runs: CheckRun[],
    allowRewrite: boolean,
  ) => Promise<JudgeResult>;
  now: () => string;
  /**
   * Time left (ms) for this hypothesis. Tests past it become `nao_testou` and the rewrite's second round is
   * skipped: the step has 15 min (WORK_STEP), and a full browser cycle can exceed that.
   */
  timeLeft: () => number;
  /**
   * May the judge swap the cause ("reescrita")? Not in the chained round, where a new cause would skip triage and
   * review; its findings feed a new hypothesis round instead (`reinvestigate`). Absent = may (single "verify again").
   */
  allowRewrite?: boolean;
}

export type VerifyOutcome =
  | { kind: "keep"; verification: HypothesisVerification; confidence: number }
  | { kind: "drop"; verification: HypothesisVerification; reason: string }
  | {
      kind: "rewrite";
      verification: HypothesisVerification;
      draft: RewriteDraft;
      confidence: number;
    };

const NOTHING_TO_TEST = "não há o que testar na página ou no código";
const OUT_OF_TIME = "sem tempo nesta rodada";

const outOfTime = (check: VerifyCheck): CheckRun => ({
  check,
  outcome: "nao_testou",
  observed: OUT_OF_TIME,
  screenshot_url: null,
  source_ref: null,
});

const notRun = (check: VerifyCheck, why: unknown): CheckRun => ({
  check,
  outcome: "nao_testou",
  observed: `o teste quebrou: ${why instanceof Error ? why.message : String(why)}`,
  screenshot_url: null,
  source_ref: null,
});

/** One plan → tests → judge cycle. Plan/judge exceptions propagate to the caller. */
async function cycle(
  h: UxHypothesis,
  deps: VerifyDeps,
  allowRewrite: boolean,
): Promise<{ plan: ParsedPlan; judged: JudgeResult | null }> {
  const plan = await deps.plan(h);
  if (plan.checks.length === 0) return { plan, judged: null };

  const runs: CheckRun[] = [];
  const liveQueue = plan.checks.filter((c) => c.stage === "live");
  // Repo first: what it finds in the code may request a browser test.
  for (const check of plan.checks.filter((c) => c.stage === "repo")) {
    if (deps.timeLeft() <= 0) {
      runs.push(outOfTime(check));
      continue;
    }
    try {
      const r = await deps.repo(check, h);
      runs.push(r.run);
      if (r.followup) liveQueue.push(r.followup);
    } catch (e) {
      runs.push(notRun(check, e));
    }
  }
  for (const check of liveQueue) {
    if (deps.timeLeft() <= 0) {
      runs.push(outOfTime(check));
      continue;
    }
    try {
      runs.push(await deps.live(check));
    } catch (e) {
      runs.push(notRun(check, e));
    }
  }
  return { plan, judged: await deps.judge(h, runs, allowRewrite) };
}

const confirmedConfidence = (c: number) =>
  Math.min(CONFIRM_CEILING, c + CONFIRM_BOOST);

/** Temporary hypothesis for the rewrite: same identity, the draft's text. */
function draftHypothesis(h: UxHypothesis, d: RewriteDraft): UxHypothesis {
  return {
    ...h,
    title: d.title,
    why: d.why,
    idea: d.idea,
    where: d.where,
    evidence_md: `${d.evidence_md}\n\n**Se for isso:** ${d.prediction}`,
  };
}

/**
 * "Verify again" starts from the hypothesis before its first verification: the confidence (else each confirmation
 * adds the bonus again) and, if already rewritten, the original hypothesis the UI shows struck through.
 */
export function verificationBase(h: UxHypothesis): {
  confidence: number;
  rewrittenFrom: HypothesisVerification["rewritten_from"];
} {
  return {
    confidence: h.verification?.base_confidence ?? h.confidence,
    rewrittenFrom: h.verification?.rewritten_from ?? null,
  };
}

/**
 * Why "verify again" cannot take this hypothesis; null = it can. Only pending ones without "ver no código": the
 * verification may rewrite or delete it, taking along an approval or a repo After built on it.
 */
export function reverifyBlock(h: UxHypothesis): string | null {
  if (h.status === "approved" || h.code_status) {
    return "essa hipótese já foi aprovada (ou tem 'ver no código'): verificar de novo pode reescrever ou apagar";
  }
  if (h.status !== "pending") {
    return "essa hipótese foi descartada: volte ela pra pendente antes de verificar de novo";
  }
  return null;
}

export async function verifyHypothesis(
  h: UxHypothesis,
  deps: VerifyDeps,
): Promise<VerifyOutcome> {
  const base = verificationBase(h);
  const verification = (
    verdict: HypothesisVerification["verdict"],
    summary: string,
    runs: CheckRun[],
    rewrittenFrom: HypothesisVerification["rewritten_from"] = base.rewrittenFrom,
  ): HypothesisVerification => ({
    verdict,
    summary,
    runs,
    rewritten_from: rewrittenFrom,
    verified_at: deps.now(),
    base_confidence: base.confidence,
  });
  // Inconclusive leaves the hypothesis alone: it keeps its current confidence.
  const inconclusive = (summary: string): VerifyOutcome => ({
    kind: "keep",
    verification: verification("inconclusiva", summary, []),
    confidence: h.confidence,
  });

  // One rewrite per hypothesis, also across "verify again" runs.
  const mayRewrite = base.rewrittenFrom === null && deps.allowRewrite !== false;
  try {
    const first = await cycle(h, deps, mayRewrite);
    if (!first.judged) {
      return inconclusive(first.plan.untestable ?? NOTHING_TO_TEST);
    }
    const j = first.judged;

    if (j.verdict === "confirmada") {
      return {
        kind: "keep",
        verification: verification("confirmada", j.summary, j.runs),
        confidence: confirmedConfidence(base.confidence),
      };
    }
    // The judge rewrote when it could not: counts as refuted.
    if (
      j.verdict === "desmentida" ||
      (j.verdict === "reescrita" && !mayRewrite)
    ) {
      // The judge's proposed cause becomes an investigation line, with triage.
      const suggested = j.rewrite ? [`outra causa: ${j.rewrite.title}`] : [];
      return {
        kind: "drop",
        verification: {
          ...verification("desmentida", j.summary, j.runs),
          novas_linhas: [...(j.novas_linhas ?? []), ...suggested],
        },
        reason: j.summary,
      };
    }
    if (j.verdict === "inconclusiva" || !j.rewrite) {
      return {
        kind: "keep",
        verification: verification("inconclusiva", j.summary, j.runs),
        confidence: h.confidence,
      };
    }

    // Rewrite: a second verification; without time, the unverified rewrite does not count.
    if (deps.timeLeft() <= 0) {
      return {
        kind: "keep",
        verification: verification(
          "inconclusiva",
          `${j.summary} A reescrita ficou sem verificar: ${OUT_OF_TIME}.`,
          j.runs,
        ),
        confidence: h.confidence,
      };
    }
    const draft = j.rewrite;
    const second = await cycle(draftHypothesis(h, draft), deps, false);
    const s = second.judged;
    // Rewriting a rewrite: the UI keeps showing the original.
    const from = base.rewrittenFrom ?? { title: h.title, why: h.why };
    // Empty second plan: nothing to refute, counts as inconclusive (the rewrite stays).
    if (!s) {
      return {
        kind: "rewrite",
        draft,
        verification: verification(
          "reescrita",
          second.plan.untestable ?? NOTHING_TO_TEST,
          [],
          from,
        ),
        confidence: base.confidence,
      };
    }
    // "reescrita" again counts as refuted: there is no third round.
    if (s.verdict === "desmentida" || s.verdict === "reescrita") {
      return {
        kind: "drop",
        verification: {
          ...verification("desmentida", s.summary, s.runs),
          novas_linhas: s.novas_linhas ?? [],
        },
        reason: s.summary,
      };
    }
    return {
      kind: "rewrite",
      draft,
      verification: verification("reescrita", s.summary, s.runs, from),
      confidence:
        s.verdict === "confirmada"
          ? confirmedConfidence(base.confidence)
          : base.confidence,
    };
  } catch (e) {
    rethrowNoAiModel(e);
    return inconclusive(
      `a verificação falhou: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function planJudgeDeps(opts: {
  llm: Llm;
  opportunity: UxOpportunity;
  evidence: DiagnosisEvidence;
  onUsage: (u: LlmUsage) => void;
}): Pick<VerifyDeps, "plan" | "judge"> {
  return {
    plan: (hypothesis) =>
      planVerification({
        llm: opts.llm,
        hypothesis,
        opportunity: opts.opportunity,
        evidence: opts.evidence,
        onUsage: opts.onUsage,
      }),
    judge: (hypothesis, runs, allowRewrite) =>
      judgeVerification({
        llm: opts.llm,
        hypothesis,
        runs,
        allowRewrite,
        scroll: scrollForPrompt(opts.evidence),
        onUsage: opts.onUsage,
      }),
  };
}

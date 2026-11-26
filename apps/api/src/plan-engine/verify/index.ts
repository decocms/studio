/**
 * Orquestração da verificação de UMA hipótese: plano → testes de repo (os
 * `followup` entram na fila do navegador) → testes live → veredito. Tudo entra
 * por `VerifyDeps`, então a ordem e as regras de desfecho testam sem rede nem
 * Chrome. O chamador compõe `planJudgeDeps` com o navegador e o repositório.
 */

import type { Llm, LlmUsage } from "../ports.ts";
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
   * Quanto falta (ms) pro prazo desta hipótese. Teste que começaria depois
   * dele sai `nao_testou` e a segunda volta da reescrita não roda: o step tem
   * 15 min (WORK_STEP), e um ciclo inteiro com navegador passa disso.
   */
  timeLeft: () => number;
  /**
   * O juiz pode trocar a causa por outra ("reescrita")? Na rodada encadeada,
   * não (19/11): a causa nova saía do juiz sem passar pela triagem nem pela
   * revisão. O que ele viu volta como fato pra uma nova rodada de hipóteses
   * (ux-verify-phase.ts, `reinvestigate`). Ausente = pode (o "verificar de
   * novo" de uma hipótese avulsa).
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

/** Um ciclo plano → testes → juiz. Exceção de plan/judge sobe pro chamador. */
async function cycle(
  h: UxHypothesis,
  deps: VerifyDeps,
  allowRewrite: boolean,
): Promise<{ plan: ParsedPlan; judged: JudgeResult | null }> {
  const plan = await deps.plan(h);
  if (plan.checks.length === 0) return { plan, judged: null };

  const runs: CheckRun[] = [];
  const liveQueue = plan.checks.filter((c) => c.stage === "live");
  // Repo primeiro: o que ele achar no código pode pedir um teste no navegador.
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

/** Hipótese temporária da reescrita: mesma identidade, texto do rascunho. */
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
 * "Verificar de novo" parte do que a hipótese era antes da primeira
 * verificação: a confiança (senão cada confirmação soma o bônus outra vez) e,
 * se ela já foi reescrita, a hipótese original que a tela mostra riscada.
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
 * Por que o "verificar de novo" não pega esta hipótese; null = pode. Só
 * pendente e sem "ver no código": a verificação pode reescrever ou apagar, e
 * levaria junto uma aprovação ou um Depois do repo feitos sobre a hipótese.
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
  // Inconclusiva não mexe na hipótese: fica a confiança que ela tem hoje.
  const inconclusive = (summary: string): VerifyOutcome => ({
    kind: "keep",
    verification: verification("inconclusiva", summary, []),
    confidence: h.confidence,
  });

  // Uma reescrita por hipótese, também entre um "verificar de novo" e outro.
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
    // O juiz não podia reescrever e reescreveu: vale desmentida.
    if (
      j.verdict === "desmentida" ||
      (j.verdict === "reescrita" && !mayRewrite)
    ) {
      // A causa que o juiz proporia vira linha de investigação, com triagem.
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

    // Reescrita: uma segunda verificação; sem tempo, a reescrita não verificada não vale.
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
    // Reescrever uma reescrita: a tela continua mostrando a original.
    const from = base.rewrittenFrom ?? { title: h.title, why: h.why };
    // Segundo plano vazio: nada a refutar, vale como inconclusiva (rewrite fica).
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
    // "reescrita" de novo vale desmentida: não há terceira rodada.
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

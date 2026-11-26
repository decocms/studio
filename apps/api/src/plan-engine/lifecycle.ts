/**
 * A hypothesis's lifecycle, from generated to ready for an A/B. A confirmed
 * CONDITION is not a confirmed CAUSE: only an A/B shows the latter, so the
 * causal level is always "not tested" here. `status` stays the person's
 * decision; the lifecycle is how far the evidence got.
 */

import type { UxHypothesis, UxOpportunity } from "./types.ts";
import type { CheckRun, HypothesisVerification } from "./verify/types.ts";

export type Lifecycle =
  | "gerada"
  | "em_investigacao"
  | "condicao_confirmada"
  | "relevancia_avaliada"
  | "pronta_para_experimento"
  | "refutada"
  | "inconclusiva"
  | "bloqueada"
  | "sem_relevancia";

export const LIFECYCLE_WORD: Record<Lifecycle, string> = {
  gerada: "gerada",
  em_investigacao: "em investigação",
  condicao_confirmada: "condição confirmada",
  relevancia_avaliada: "relevância avaliada",
  pronta_para_experimento: "pronta pro teste",
  refutada: "refutada",
  inconclusiva: "inconclusiva",
  bloqueada: "bloqueada (sem acesso ou dado)",
  sem_relevancia: "sem relevância",
};

export interface LifecycleEntry {
  state: Lifecycle;
  at: string;
  reason: string;
}

/** Where each state can go. "Verify again" returns to investigation. */
const NEXT: Record<Lifecycle, Lifecycle[]> = {
  gerada: ["em_investigacao", "refutada", "bloqueada"],
  em_investigacao: [
    "condicao_confirmada",
    "refutada",
    "inconclusiva",
    "bloqueada",
  ],
  condicao_confirmada: [
    "relevancia_avaliada",
    "sem_relevancia",
    "em_investigacao",
  ],
  relevancia_avaliada: [
    "pronta_para_experimento",
    "em_investigacao",
    "relevancia_avaliada",
  ],
  pronta_para_experimento: ["relevancia_avaliada", "em_investigacao"],
  refutada: ["em_investigacao"],
  inconclusiva: ["em_investigacao"],
  bloqueada: ["em_investigacao"],
  sem_relevancia: ["em_investigacao", "relevancia_avaliada"],
};

const canMove = (from: Lifecycle, to: Lifecycle) =>
  from === to || NEXT[from].includes(to);

/** Moves the hypothesis to `to`; a transition the table forbids returns null, so a late Workflow step cannot undo progress. */
export function advance(
  current: { lifecycle: Lifecycle; lifecycle_log: LifecycleEntry[] },
  to: Lifecycle,
  reason: string,
  at: string,
): { lifecycle: Lifecycle; lifecycle_log: LifecycleEntry[] } | null {
  if (!canMove(current.lifecycle, to)) return null;
  return {
    lifecycle: to,
    lifecycle_log: [...current.lifecycle_log, { state: to, at, reason }].slice(
      -20,
    ),
  };
}

/** Runs that count: the judge did not say they measure something other than the cause. */
const counted = (runs: CheckRun[]) =>
  runs.filter((r) => r.measures_cause !== false);

/** The state a verifier verdict produces. */
export function lifecycleFromVerification(
  v: HypothesisVerification,
): Lifecycle {
  const runs = counted(v.runs);
  if (v.verdict === "confirmada") return "condicao_confirmada";
  if (v.verdict === "desmentida") return "refutada";
  if (v.verdict === "reescrita") {
    return runs.some((r) => r.outcome === "confirma") &&
      !runs.some((r) => r.outcome === "desmente")
      ? "condicao_confirmada"
      : "inconclusiva";
  }
  // Nothing ran: access was missing, not evidence
  return v.runs.length === 0 || v.runs.every((r) => r.outcome === "nao_testou")
    ? "bloqueada"
    : "inconclusiva";
}

/** The state of a hypothesis stored before the lifecycle existed. */
export function lifecycleOf(
  h: Pick<UxHypothesis, "verification"> & { lifecycle?: Lifecycle | null },
): Lifecycle {
  if (h.lifecycle) return h.lifecycle;
  return h.verification ? lifecycleFromVerification(h.verification) : "gerada";
}

/** States where the hypothesis dropped for good in this round. */
export const isNegative = (s: Lifecycle) =>
  s === "refutada" || s === "sem_relevancia";

/** The condition has already been seen on the page (or in the data). */
const CONFIRMED: Lifecycle[] = [
  "condicao_confirmada",
  "relevancia_avaliada",
  "pronta_para_experimento",
];

/** Approving needs a ready hypothesis: confirmed condition, relevance at least medium, measurable test, reliable data. */
const APPROVABLE: Lifecycle[] = ["pronta_para_experimento"];

export const canApprove = (s: Lifecycle) => APPROVABLE.includes(s);

// ── The four validation levels ───────────────────────────────────────────────

export type LevelResult =
  | "confirmada"
  | "refutada"
  | "conflito"
  | "inconclusiva"
  | "nao_testada";

export interface HypothesisValidation {
  /** Does the condition exist? */
  existencia: LevelResult;
  /** How is it implemented? (store code) */
  implementacao: LevelResult;
  /** Does it matter for the problem? (relevance.ts) */
  relevancia: "alta" | "media" | "baixa" | "sem_relevancia" | "nao_avaliada";
  /** Does changing it change conversion? Only an A/B answers. */
  causal: "nao_testado";
}

function level(runs: CheckRun[]): LevelResult {
  if (runs.length === 0) return "nao_testada";
  const yes = runs.some((r) => r.outcome === "confirma");
  const no = runs.some((r) => r.outcome === "desmente");
  if (yes && no) return "conflito";
  if (yes) return "confirmada";
  if (no) return "refutada";
  return runs.every((r) => r.outcome === "nao_testou")
    ? "nao_testada"
    : "inconclusiva";
}

export function validationOf(
  v: HypothesisVerification | null,
  relevancia: HypothesisValidation["relevancia"] = "nao_avaliada",
): HypothesisValidation {
  const runs = counted(v?.runs ?? []);
  return {
    existencia: level(
      runs.filter((r) => r.check.stage === "live" || r.check.stage === "data"),
    ),
    implementacao: level(runs.filter((r) => r.check.stage === "repo")),
    relevancia,
    causal: "nao_testado",
  };
}

// ── When to stop investigating an opportunity ────────────────────────────────

export type StopReason =
  | "achou_causa_candidata"
  | "todas_descartadas"
  | "evidencias_esgotadas"
  | "orcamento"
  | "dados_insuficientes";

export interface OpportunityOutcome {
  stop: StopReason;
  /** Left the main list (no hypothesis standing); stays under "no cause". */
  retired: boolean;
  note: string;
}

/** Why the investigation stopped. "Evidence exhausted" and "insufficient data" are answers, not failures. */
export function stopReasonOf(
  opportunity: Pick<UxOpportunity, "reliability">,
  hypotheses: Array<
    Pick<UxHypothesis, "verification" | "tree"> & {
      lifecycle?: Lifecycle | null;
      review?: { explica_o_gap: "sim" | "parcial" | "nao" } | null;
    }
  >,
): OpportunityOutcome {
  const states = hypotheses.map(lifecycleOf);
  // "Confirmed" means the condition exists, not that it explains the loss
  const confirmed = hypotheses.filter((_, i) => CONFIRMED.includes(states[i]!));
  if (confirmed.some((h) => h.review?.explica_o_gap !== "nao")) {
    return {
      stop: "achou_causa_candidata",
      retired: false,
      note: "Uma condição foi confirmada; falta mostrar que ela causa a perda (A/B).",
    };
  }
  if (confirmed.length > 0) {
    return {
      stop: "evidencias_esgotadas",
      retired: false,
      note: "A condição existe na página, mas nada liga ela a esta perda: o revisor independente leu o dossiê e diz que não explica.",
    };
  }
  if (opportunity.reliability?.level === "baixa") {
    return {
      stop: "dados_insuficientes",
      retired: false,
      note: "Os dados que sustentam a oportunidade são frágeis: investigar mais não decide.",
    };
  }
  const pending = hypotheses.filter(
    (h, i) => states[i] === "gerada" && h.tree?.testavel_na_pagina !== false,
  );
  if (pending.length > 0) {
    return {
      stop: "orcamento",
      retired: false,
      note: `${pending.length} hipótese(s) ficaram sem investigar nesta rodada (limite por oportunidade); dá pra verificar uma a uma.`,
    };
  }
  if (states.length > 0 && states.every(isNegative)) {
    return {
      stop: "todas_descartadas",
      retired: true,
      note: "Todas as hipóteses foram descartadas.",
    };
  }
  return {
    stop: "evidencias_esgotadas",
    retired: false,
    note: "O que dava pra conferir na página, no código e nos dados não decidiu nenhuma hipótese.",
  };
}

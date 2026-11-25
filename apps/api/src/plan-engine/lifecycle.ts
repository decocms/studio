/**
 * O ciclo de vida de uma hipótese — onde ela está entre "alguém pensou nisso"
 * e "pronta pra um A/B".
 *
 *   gerada → em_investigacao → condicao_confirmada → relevancia_avaliada
 *          → pronta_para_experimento
 *   saídas: refutada · inconclusiva · bloqueada · sem_relevancia
 *
 * O ponto do motor: CONDIÇÃO confirmada não é CAUSA confirmada. O verificador
 * mostra que o botão está abaixo da dobra; só um A/B mostra que isso derruba a
 * conversão. Por isso o nível causal é sempre "não testado" aqui.
 *
 * `status` (pending/approved/dismissed) continua sendo a decisão da pessoa; o
 * ciclo é onde a evidência chegou. Aprovar só vale depois da condição
 * confirmada (`canApprove`).
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

/** De onde cada estado pode ir. "Verificar de novo" volta pra investigação. */
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

/**
 * Leva a hipótese pra `to`, registrando o porquê. Transição que a tabela não
 * permite não muda nada (devolve null): um passo atrasado da Workflow não pode
 * desfazer o que já andou.
 */
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

/** Runs que contam: o juiz não disse que medem outra coisa que não a causa. */
const counted = (runs: CheckRun[]) =>
  runs.filter((r) => r.measures_cause !== false);

/** O estado que um veredito do verificador produz. */
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
  // Nada rodou (sem navegador, sem repo, plano vazio): faltou acesso, não
  // evidência.
  return v.runs.length === 0 || v.runs.every((r) => r.outcome === "nao_testou")
    ? "bloqueada"
    : "inconclusiva";
}

/** O estado de uma hipótese gravada antes do ciclo existir (lifecycle NULL). */
export function lifecycleOf(
  h: Pick<UxHypothesis, "verification"> & { lifecycle?: Lifecycle | null },
): Lifecycle {
  if (h.lifecycle) return h.lifecycle;
  return h.verification ? lifecycleFromVerification(h.verification) : "gerada";
}

/** Estados em que a hipótese caiu de vez nesta rodada. */
const isNegative = (s: Lifecycle) => s === "refutada" || s === "sem_relevancia";

/** A condição já foi vista na página (ou nos dados). */
const CONFIRMED: Lifecycle[] = [
  "condicao_confirmada",
  "relevancia_avaliada",
  "pronta_para_experimento",
];

/**
 * Aprovar pra teste exige a hipótese pronta: condição confirmada, relevância
 * pelo menos média, teste mensurável e dados confiáveis (priority.ts).
 */
const APPROVABLE: Lifecycle[] = ["pronta_para_experimento"];

export const canApprove = (s: Lifecycle) => APPROVABLE.includes(s);

// ── Os quatro níveis de validação ────────────────────────────────────────────

export type LevelResult =
  | "confirmada"
  | "refutada"
  | "conflito"
  | "inconclusiva"
  | "nao_testada";

export interface HypothesisValidation {
  /** A condição existe? (página no ar, ou os dados pra hipótese de tráfego) */
  existencia: LevelResult;
  /** Como está implementado? (código da loja) */
  implementacao: LevelResult;
  /** Importa pro problema? (relevance.ts, PR F) */
  relevancia: "alta" | "media" | "baixa" | "sem_relevancia" | "nao_avaliada";
  /** Mudar isso muda a conversão? Só um A/B responde. */
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

// ── Quando parar de investigar uma oportunidade ──────────────────────────────

export type StopReason =
  | "achou_causa_candidata"
  | "todas_descartadas"
  | "evidencias_esgotadas"
  | "orcamento"
  | "dados_insuficientes";

export interface OpportunityOutcome {
  stop: StopReason;
  /** Saiu da lista principal (nenhuma hipótese de pé); fica em "sem causa". */
  retired: boolean;
  note: string;
}

/**
 * Por que a investigação desta oportunidade parou. O sistema não é obrigado a
 * achar uma causa: "evidências esgotadas" e "dados insuficientes" são
 * respostas, não falhas.
 */
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
  // "Confirmada" é a condição existir (o código não tem sticky), não a causa.
  // Em 16/11 (categoria de uma loja de moda) a tela disse "achamos uma causa candidata" com
  // o revisor respondendo que ela NÃO explica a perda.
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

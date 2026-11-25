/**
 * O tipo de cada afirmação do diagnóstico. Uma IA escreve explicação
 * convincente sem evidência nenhuma; o rótulo é o que deixa a tela separar o
 * que foi visto do que foi deduzido.
 *
 * - fato_observado: lido direto num dado ou na página nesta análise.
 * - evidencia_indireta: sugere, não comprova (benchmark, uma carga de laboratório).
 * - inferencia: interpretação montada pelo sistema.
 * - hipotese: explicação ainda não comprovada.
 * - conclusao_experimental: resultado de A/B controlado. O modelo nunca dá esse.
 */

import type { Grounding } from "./facts.ts";
import type { UxSourceKind } from "./types.ts";

export type UxClaimLabel =
  | "fato_observado"
  | "evidencia_indireta"
  | "inferencia"
  | "hipotese"
  | "conclusao_experimental";

/**
 * O rótulo de um número do "baseado em", pela fonte. O que os concorrentes
 * fazem é sinal de mercado, não fato sobre esta loja.
 */
export function sourceLabel(source: UxSourceKind): UxClaimLabel {
  return source === "benchmark" ? "evidencia_indireta" : "fato_observado";
}

const LABELS: UxClaimLabel[] = [
  "fato_observado",
  "evidencia_indireta",
  "inferencia",
  "hipotese",
  "conclusao_experimental",
];

/**
 * O rótulo que o modelo deu, rebaixado quando não se sustenta: "fato" sem
 * número não é fato (vira inferência), e conclusão de experimento nunca vem do
 * modelo — só um A/B dá isso, e nenhum rodou aqui.
 */
export function clampLabel(raw: unknown, text: string): UxClaimLabel {
  const label = LABELS.find((l) => l === raw) ?? "inferencia";
  if (label === "conclusao_experimental") return "inferencia";
  if (label === "fato_observado" && !/\d/.test(text)) return "inferencia";
  return label;
}

/**
 * O rótulo conferido contra os fatos citados (facts.ts). O modelo só PEDE o
 * rótulo; quem dá é o código:
 * - "fato_observado" só com fato MEDIDO citado, nenhum id inventado e todo
 *   número da frase nos fatos citados;
 * - citando só leitura de print (concorrente), no máximo "evidencia_indireta";
 * - o resto vira "inferencia".
 * Até 19/11 o "fato" era o que o modelo dizia que era, desde que tivesse um
 * dígito (clampLabel).
 */
export function groundedLabel(raw: unknown, g: Grounding): UxClaimLabel {
  const asked = LABELS.find((l) => l === raw) ?? "inferencia";
  if (asked === "conclusao_experimental") return "inferencia";
  if (asked !== "fato_observado") return asked;
  const clean = g.unknown.length === 0 && g.unsupported.length === 0;
  if (!clean || g.facts.length === 0) return "inferencia";
  return g.facts.every((f) => f.measured)
    ? "fato_observado"
    : "evidencia_indireta";
}

export const CLAIM_WORD: Record<UxClaimLabel, string> = {
  fato_observado: "fato",
  evidencia_indireta: "indireto",
  inferencia: "inferência",
  hipotese: "hipótese",
  conclusao_experimental: "teste A/B",
};

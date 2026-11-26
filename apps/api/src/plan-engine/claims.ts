/**
 * The kind of each diagnosis claim, so the screen can separate what was seen
 * from what was deduced. `conclusao_experimental` is a controlled A/B result;
 * the model never gives it.
 */

import type { Grounding } from "./facts.ts";
import type { UxSourceKind } from "./types.ts";

export type UxClaimLabel =
  | "fato_observado"
  | "evidencia_indireta"
  | "inferencia"
  | "hipotese"
  | "conclusao_experimental";

/** The label of an "based on" number, by source. Competitor behaviour is a market signal, not a fact about this store. */
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

/** The model's label, downgraded when unsupported: a "fact" without a number is an inference, and an experiment conclusion never comes from the model. */
export function clampLabel(raw: unknown, text: string): UxClaimLabel {
  const label = LABELS.find((l) => l === raw) ?? "inferencia";
  if (label === "conclusao_experimental") return "inferencia";
  if (label === "fato_observado" && !/\d/.test(text)) return "inferencia";
  return label;
}

/**
 * The label checked against the cited facts (facts.ts). The model only
 * REQUESTS a label; code grants it: "fato_observado" needs a MEASURED fact, no
 * invented id and every number in the sentence in the cited facts; screenshot
 * reads alone give at most "evidencia_indireta"; the rest is "inferencia".
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

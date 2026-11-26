/**
 * The independent reviewer: reads ONLY the dossier and answers whether the
 * evidence shows the hypothesis explains the conversion gap. The code applies
 * it only downward: "nao" demotes the hypothesis, "parcial" cuts test priority
 * 20%, "sim" changes nothing. A failed review is shown as a limitation.
 */

export interface HypothesisReview {
  explica_o_gap: "sim" | "parcial" | "nao";
  resposta: string;
  falhas: string[];
  reviewed_at: string;
}

/**
 * The diagnosis knowledge base: general e-commerce conversion knowledge
 * (curated.ts, reviewed in PR) plus what was learned about THIS store. Each
 * entry records its origin, weight and where it does not apply, so a study, another store's A/B
 * and this store's own A/B do not weigh the same.
 */

import type { UxArea } from "../types.ts";

export type KnowledgeCategory =
  | "ux"
  | "performance"
  | "confianca"
  | "comercial"
  | "trafego"
  | "tecnologia";

export type KnowledgeSourceType =
  | "ab_desta_loja"
  | "veredito_desta_loja"
  | "estudo"
  | "ab_outra_loja"
  | "benchmark"
  | "boa_pratica"
  | "opiniao";

export type KnowledgeReliability = "alta" | "media" | "baixa";

/** Where the entry came from. */
export type KnowledgeOrigin = "curada" | "manual" | "veredito" | "decisao";

/** What the entry concluded. A confirmed verdict means the condition EXISTS, not that it is the cause. NULL = general knowledge. */
export type KnowledgeResult =
  | "positivo"
  | "negativo"
  | "neutro"
  | "confirmada"
  | "refutada";

export interface KnowledgeEntry {
  id: string;
  /** The claim, in one sentence. */
  conhecimento: string;
  categoria: KnowledgeCategory;
  /** Who said it. */
  fonte: string;
  fonte_url: string | null;
  tipo_fonte: KnowledgeSourceType;
  /** Where it was observed. */
  contexto: string;
  /** Page parts where it applies (any page type; areas.ts). */
  areas: UxArea[];
  /** What the source found, with a number. */
  evidencia: string;
  /** Literal excerpt from the source (in its language) containing the number, so the citation can be checked. NULL = manual or learned. */
  trecho?: string | null;
  confiabilidade: KnowledgeReliability;
  /** Where it does not apply / what the study does not prove. */
  limitacoes: string;
  resultado: KnowledgeResult | null;
  origem: KnowledgeOrigin;
  diagnosis_id: string | null;
  hypothesis_id: string | null;
  /** The page signature when the verdict was learned (validity.ts). NULL = not page-dependent. */
  assinatura?: string | null;
  /** Computed at analysis time, not stored: the page changed since the verdict (`markStale`). */
  stale?: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** How much each source type weighs. Benchmark is a market signal, not proof. */
export const SOURCE_WEIGHT: Record<KnowledgeSourceType, number> = {
  ab_desta_loja: 1,
  veredito_desta_loja: 0.8,
  estudo: 0.7,
  ab_outra_loja: 0.5,
  benchmark: 0.3,
  boa_pratica: 0.3,
  opiniao: 0.1,
};

export const RELIABILITY_WEIGHT: Record<KnowledgeReliability, number> = {
  alta: 1,
  media: 0.7,
  baixa: 0.4,
};

export const SOURCE_TYPE_LABEL: Record<KnowledgeSourceType, string> = {
  ab_desta_loja: "A/B desta loja",
  veredito_desta_loja: "verificado nesta loja",
  estudo: "estudo",
  ab_outra_loja: "A/B de outra loja",
  benchmark: "benchmark",
  boa_pratica: "boa prática",
  opiniao: "opinião",
};

/** Types that only enter with a source link, which guards against invented citations. */
export const NEEDS_URL: KnowledgeSourceType[] = ["estudo", "ab_outra_loja"];

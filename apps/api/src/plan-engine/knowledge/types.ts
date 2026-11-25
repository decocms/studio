/**
 * A base de conhecimento do diagnóstico: o que se sabe sobre conversão de
 * e-commerce em geral (curated.ts, revisado em PR) e o que se aprendeu sobre
 * ESTA loja (tabela ux_knowledge: vereditos, decisões e A/Bs cadastrados).
 *
 * Não é um banco de artigos: cada entrada diz de onde veio, quanto vale e
 * onde não se aplica. Um estudo, um A/B de outra loja e o que 10 concorrentes
 * fazem não podem pesar igual — e um A/B desta loja vale mais que todos eles.
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

/** De onde a entrada entrou na base. */
export type KnowledgeOrigin = "curada" | "manual" | "veredito" | "decisao";

/**
 * O que a entrada concluiu. Pra A/B: positivo/negativo/neutro. Pra veredito do
 * verificador: confirmada (a condição EXISTE na loja; não prova causa) ou
 * refutada. NULL = conhecimento geral.
 */
export type KnowledgeResult =
  | "positivo"
  | "negativo"
  | "neutro"
  | "confirmada"
  | "refutada";

export interface KnowledgeEntry {
  id: string;
  /** A afirmação, numa frase ("Custo extra inesperado faz abandonar o carrinho"). */
  conhecimento: string;
  categoria: KnowledgeCategory;
  /** Quem disse ("Baymard Institute, pesquisa anual de abandono"). */
  fonte: string;
  fonte_url: string | null;
  tipo_fonte: KnowledgeSourceType;
  /** Onde foi observado ("compradoras dos EUA, todos os segmentos"). */
  contexto: string;
  /** Partes da página onde vale (de qualquer tipo de página; areas.ts). */
  areas: UxArea[];
  /** O que a fonte achou, com número. */
  evidencia: string;
  /**
   * Trecho literal da fonte (no idioma dela) que contém o número: é o que
   * deixa conferir que a citação não foi inventada. NULL = entrada manual ou
   * aprendida (o veredito não tem fonte externa).
   */
  trecho?: string | null;
  confiabilidade: KnowledgeReliability;
  /** Onde não se aplica / o que o estudo não prova. */
  limitacoes: string;
  resultado: KnowledgeResult | null;
  origem: KnowledgeOrigin;
  diagnosis_id: string | null;
  hypothesis_id: string | null;
  /**
   * A assinatura da página quando o veredito foi aprendido (validity.ts).
   * NULL = não depende de uma página (geral, manual, decisão, tráfego).
   */
  assinatura?: string | null;
  /**
   * Calculado na análise, não gravado: a página mudou desde o veredito
   * (`markStale`). Vai pro prompt como histórico, com peso menor.
   */
  stale?: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Quanto cada tipo de fonte pesa. Benchmark é sinal de mercado, não prova. */
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

/** Tipos que só entram com link pra fonte: é o que segura citação inventada. */
export const NEEDS_URL: KnowledgeSourceType[] = ["estudo", "ab_outra_loja"];

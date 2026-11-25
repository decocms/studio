/**
 * O que a loja aprende sozinha: cada veredito do verificador e cada decisão
 * da equipe vira uma entrada da base, e a próxima análise lê isso antes de
 * escrever hipótese. Sem isto, uma hipótese desmentida hoje voltava igual na
 * semana que vem.
 *
 * O id é determinístico (`<origem>:<hipótese>`): verificar de novo ou mudar a
 * decisão substitui a entrada, não duplica.
 */

import type { UxArea, UxHypothesis } from "../types.ts";
import type { HypothesisVerification } from "../verify/types.ts";
import type { KnowledgeCategory, KnowledgeEntry } from "./types.ts";

export type KnowledgeDraft = Omit<KnowledgeEntry, "created_at" | "updated_at">;

const AREA_CATEGORY: Partial<Record<UxArea, KnowledgeCategory>> = {
  frete_entrega: "comercial",
  titulo_preco: "comercial",
  confianca: "confianca",
  carrinho_checkout: "comercial",
  carrinho: "comercial",
  checkout: "comercial",
};

export const categoryForArea = (area: UxArea): KnowledgeCategory =>
  AREA_CATEGORY[area] ?? "ux";

/** A parte da página que cada alvo da árvore mira. */
const PART_AREA: Record<string, UxArea> = {
  price: "titulo_preco",
  size_selector: "tamanho",
  buy_button: "botao_compra",
  shipping: "frete_entrega",
  first_recommendation: "recomendacoes",
  hero: "home_destaque",
  first_shelf: "home_vitrines",
  first_product: "home_vitrines",
  search_entry: "menu_busca",
  menu_button: "menu_busca",
  page_title: "topo_categoria",
  filter_button: "filtros_ordenacao",
  sort_button: "filtros_ordenacao",
  load_more: "paginacao",
  search_field: "campo_busca",
  results_count: "resultados_busca",
};

/** O 1º card é da lista na categoria e dos resultados na busca. */
const FIRST_CARD_AREA: Partial<Record<UxArea, UxArea>> = {
  resultados_busca: "resultados_busca",
  campo_busca: "resultados_busca",
  busca_sem_resultado: "resultados_busca",
};

/**
 * Em que partes da página o aprendizado vale: a que a hipótese mira, e a da
 * oportunidade. Em 15/11 (numa loja) "não é o caso: o botão de compra fica
 * abaixo da dobra" foi gravado só como "navegacao" (a área da oportunidade de
 * mídia paga) e nunca apareceria quando a análise olhasse o botão de compra.
 * Seção (pop-up, vitrine) vale pra PDP inteira. Exportado pra teste.
 */
export function areasFor(
  h: Pick<UxHypothesis, "tree">,
  opportunityArea: UxArea,
): UxArea[] {
  const alvo = h.tree?.alvo;
  const target =
    alvo?.kind === "part"
      ? alvo.key === "first_card"
        ? (FIRST_CARD_AREA[opportunityArea] ?? "card_produto")
        : PART_AREA[alvo.key]
      : alvo?.kind === "section"
        ? "pagina_geral"
        : undefined;
  return target && target !== opportunityArea
    ? [target, opportunityArea]
    : [opportunityArea];
}

export const learnedId = (
  origem: "veredito" | "decisao",
  hypothesisId: string,
) => `${origem}:${hypothesisId}`;

const day = (iso: string) => iso.slice(0, 10);

/**
 * Veredito do verificador → entrada. Inconclusiva não ensina nada (null).
 * "Confirmada" é dita como condição, nunca como causa.
 */
export function fromVerification(input: {
  hypothesis: UxHypothesis;
  area: UxArea;
  verification: HypothesisVerification;
  pageUrl: string | null;
  /** A assinatura da página no dia (validity.ts). NULL = não depende dela. */
  signature?: string | null;
}): KnowledgeDraft | null {
  const { hypothesis: h, verification: v } = input;
  if (v.verdict === "inconclusiva") return null;
  const refuted = v.verdict === "desmentida" || v.verdict === "reescrita";
  const decided = v.runs.filter(
    (r) => r.outcome === "confirma" || r.outcome === "desmente",
  );
  const sawLive = decided.some((r) => r.check.stage === "live");
  const where = input.pageUrl ? ` em ${input.pageUrl}` : "";
  return {
    id: learnedId("veredito", h.id),
    conhecimento: refuted
      ? `Não é o caso nesta loja: ${h.title}`
      : `A condição existe nesta loja: ${h.title}`,
    categoria: categoryForArea(areasFor(h, input.area)[0]!),
    fonte: `Verificador do diagnóstico ${h.diagnosis_id.slice(0, 8)}`,
    fonte_url: null,
    tipo_fonte: "veredito_desta_loja",
    contexto: `PDP da loja${where}, ${day(v.verified_at)}`,
    areas: areasFor(h, input.area),
    evidencia: v.summary.slice(0, 400),
    confiabilidade: sawLive ? "alta" : decided.length > 0 ? "media" : "baixa",
    limitacoes: refuted
      ? "Vale pra página como estava no dia; muda se a página mudar."
      : "Confirma que a condição existe, não que ela causa a perda — isso só um A/B diz.",
    resultado: refuted ? "refutada" : "confirmada",
    origem: "veredito",
    diagnosis_id: h.diagnosis_id,
    hypothesis_id: h.id,
    assinatura: input.signature ?? null,
    active: true,
  };
}

/** Aprovar ou descartar (com o motivo) → entrada. Voltar pra pendente → null. */
export function fromDecision(input: {
  hypothesis: UxHypothesis;
  area: UxArea;
  status: UxHypothesis["status"];
  note: string | null;
  at: string;
}): KnowledgeDraft | null {
  const { hypothesis: h } = input;
  if (input.status === "pending") return null;
  const approved = input.status === "approved";
  const note = input.note?.trim();
  return {
    id: learnedId("decisao", h.id),
    conhecimento: approved
      ? `A equipe aprovou pra teste: ${h.title}${h.idea ? ` → ${h.idea}` : ""}`
      : `A equipe descartou: ${h.title}${note ? ` (motivo: ${note})` : ""}`,
    categoria: categoryForArea(areasFor(h, input.area)[0]!),
    fonte: "Decisão da equipe no PDP Optimizer",
    fonte_url: null,
    tipo_fonte: "opiniao",
    contexto: `Diagnóstico ${h.diagnosis_id.slice(0, 8)}, ${day(input.at)}`,
    areas: areasFor(h, input.area),
    evidencia: note ?? "",
    confiabilidade: note ? "media" : "baixa",
    limitacoes: "É julgamento da equipe, não resultado medido.",
    resultado: null,
    origem: "decisao",
    diagnosis_id: h.diagnosis_id,
    hypothesis_id: h.id,
    active: true,
  };
}

/**
 * Onde uma oportunidade pode morar. A mesma lista guia o prompt das
 * oportunidades, a leitura do benchmark (o que cada loja faz em cada parte da
 * página) e a validação do que o modelo devolve.
 *
 * Cada tipo de página tem as suas partes (page-types.ts). `pagina_geral` é a
 * página analisada inteira, seja qual for. `navegacao` e `carrinho_checkout`
 * são as páginas fora da analisada: o funil mostra perda antes (a peça que
 * converte e ninguém acha) e depois (carrinho → checkout), e o modelo listava
 * essas também — sem isso caíam em `pagina_geral` e a tela dizia "Página toda"
 * sem dizer de qual página.
 */

import { PAGE_TYPES } from "./page-types.ts";
import type { UxArea, UxPageType } from "./types.ts";

/** Parte → o que ela cobre, do jeito que o prompt descreve. */
export const UX_AREAS: Record<UxArea, string> = {
  home_destaque:
    "destaque da primeira tela da home: banner, carrossel, chamada principal",
  home_vitrines: "vitrines de produto da home (novidades, mais vendidos…)",
  menu_busca: "cabeçalho, menu e entrada da busca",
  topo_categoria: "topo da categoria: título, banner, atalhos de subcategoria",
  card_produto: "card de produto na lista: foto, preço, cores, selos",
  filtros_ordenacao: "filtros e ordenação da lista",
  paginacao: "paginação, carregar mais, rolagem infinita",
  campo_busca: "campo de busca e as sugestões enquanto digita",
  resultados_busca: "página de resultados da busca e a ordem deles",
  busca_sem_resultado: "o que aparece quando a busca não acha nada",
  carrinho: "carrinho: o que mostra, frete, cupom, ir pro checkout",
  checkout: "checkout: identificação, entrega, pagamento, finalizar",
  galeria: "galeria de fotos e vídeos do produto",
  titulo_preco: "nome do produto, preço, parcelamento e selo de desconto",
  tamanho: "seleção de tamanho e cor, tabela de medidas, grade esgotada",
  botao_compra: "botão de comprar, barra de compra fixa, adicionar ao carrinho",
  frete_entrega: "frete, prazo, retirada na loja, trocas",
  descricao: "descrição, composição, modelagem, cuidados",
  leve_o_look: "compre o look, peças que combinam",
  recomendacoes: "vitrines de outros produtos (você também pode gostar etc.)",
  confianca: "avaliações, fotos de clientes, garantias, selos",
  pagina_geral:
    "a página analisada como um todo: ordem das partes, dobra, velocidade, funil da página",
  navegacao:
    "FORA da página analisada: home, busca e categoria — como a cliente chega (ou não) no produto",
  carrinho_checkout:
    "FORA da página analisada: carrinho e checkout, o que acontece depois de adicionar",
};

/** A área é da página analisada (ou da página inteira)? */
export function isAreaOfPage(area: UxArea, pageType: UxPageType): boolean {
  return area === "pagina_geral" || PAGE_TYPES[pageType].areas.includes(area);
}

export function asArea(v: unknown): UxArea {
  return typeof v === "string" && v in UX_AREAS
    ? (v as UxArea)
    : "pagina_geral";
}

/**
 * As áreas que valem num diagnóstico deste tipo de página: as partes dela,
 * `pagina_geral` e as páginas de fora (menos a própria: no diagnóstico de
 * carrinho, "carrinho_checkout" já são as partes).
 */
export function areasOfDiagnosis(pageType: UxPageType): UxArea[] {
  const own = PAGE_TYPES[pageType].areas;
  const outside: UxArea[] = [];
  if (!["home", "categoria", "busca"].includes(pageType))
    outside.push("navegacao");
  if (pageType !== "carrinho_checkout") outside.push("carrinho_checkout");
  return [...own, ...outside];
}

/**
 * As partes em texto, uma por linha, pra colar no prompt. `pageOnly` é pra
 * leitura da página de um concorrente, onde as páginas de fora não aparecem.
 */
export function areasForPrompt(
  opts: { pageType?: UxPageType; pageOnly?: boolean; pdpOnly?: boolean } = {},
): string {
  const pageType = opts.pageType ?? "pdp";
  const pageOnly = opts.pageOnly ?? opts.pdpOnly ?? false;
  const keys = pageOnly
    ? PAGE_TYPES[pageType].areas
    : areasOfDiagnosis(pageType);
  return keys.map((key) => `- ${key}: ${UX_AREAS[key]}`).join("\n");
}

/** Área do modelo → uma que vale neste diagnóstico (senão a página inteira). */
export function asAreaOf(v: unknown, pageType: UxPageType): UxArea {
  const area = asArea(v);
  return areasOfDiagnosis(pageType).includes(area) ? area : "pagina_geral";
}

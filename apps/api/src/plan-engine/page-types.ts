/**
 * The page types the diagnosis analyzes. Everything that varies per page lives
 * here (prompt wording, captured parts, areas, test metric, guardrails), so the
 * rest of the code asks `PAGE_TYPES[type]` instead of hardcoding "PDP".
 * Cart and checkout belong to VTEX: no heatmap, screenshot or benchmark.
 */

import type { UxMetricKey } from "./metrics.ts";
import type { UxArea, UxPageType, UxPart } from "./types.ts";

export interface PageTypeSpec {
  key: UxPageType;
  /** Display name ("Categoria"). */
  label: string;
  /** Name inside a sentence ("a categoria", "a PDP"). */
  noun: string;
  /** What the page is, for the prompt. */
  description: string;
  /** This page's parts, in the order they appear (and `pagina_geral`). */
  areas: UxArea[];
  /** Parts the capture measures on this page → how to say them in text. */
  parts: Partial<Record<UxPart, string>>;
  /** No capture, heatmap or benchmark: only the GA4 funnel and knowledge. */
  dataOnly: boolean;
  /** The stage the test tracks when the hypothesis names no other. */
  defaultMetric: UxMetricKey;
  /** "The home as it is today": the test control. */
  control: string;
  /** What must not get worse in a test of this page, besides the usual. */
  guardrails: string[];
  /** Hint on what to look at, for step 4 of the prompt's method. */
  focus: string;
}

export const PAGE_TYPE_ORDER: UxPageType[] = [
  "home",
  "categoria",
  "busca",
  "pdp",
  "carrinho_checkout",
];

export const PAGE_TYPES: Record<UxPageType, PageTypeSpec> = {
  home: {
    key: "home",
    label: "Home",
    noun: "a home",
    description:
      "a página inicial da loja: o destaque da primeira tela, as vitrines de produto, o menu e a entrada da busca",
    areas: ["home_destaque", "home_vitrines", "menu_busca", "pagina_geral"],
    parts: {
      hero: "destaque da primeira tela",
      first_shelf: "primeira vitrine de produtos",
      first_product: "primeiro produto visível",
      search_entry: "entrada da busca",
      menu_button: "botão do menu",
    },
    dataOnly: false,
    defaultMetric: "pagina_produto",
    control: "A home como está hoje",
    guardrails: [
      "cliques no menu e na busca",
      "tempo até a primeira tela aparecer (LCP)",
    ],
    focus:
      "destaque da primeira tela (o que ocupa, se leva a produto), vitrines (quantas, onde, o que mostram), menu e busca (se dá pra achar), velocidade",
  },
  categoria: {
    key: "categoria",
    label: "Categoria",
    noun: "a categoria",
    description:
      "a página de categoria/vitrine (lista de produtos): o topo, os cards de produto, filtros e ordenação, e a paginação",
    areas: [
      "topo_categoria",
      "card_produto",
      "filtros_ordenacao",
      "paginacao",
      "pagina_geral",
    ],
    parts: {
      page_title: "título da categoria",
      filter_button: "botão de filtro",
      sort_button: "botão de ordenar",
      first_card: "primeiro card de produto",
      load_more: "carregar mais / paginação",
    },
    dataOnly: false,
    defaultMetric: "pagina_produto",
    control: "A categoria como está hoje",
    guardrails: [
      "uso de filtro e ordenação",
      "profundidade de rolagem da lista",
    ],
    focus:
      "quantos produtos aparecem na primeira tela, o que o card mostra (foto, preço, cores, tamanhos, selo), filtros e ordenação (onde, quais), paginação/carregar mais",
  },
  busca: {
    key: "busca",
    label: "Busca",
    noun: "a busca",
    description:
      "a busca do site: o campo (e as sugestões), a página de resultados e o que aparece quando não acha nada",
    areas: [
      "campo_busca",
      "resultados_busca",
      "busca_sem_resultado",
      "pagina_geral",
    ],
    parts: {
      search_field: "campo de busca",
      results_count: "total de resultados",
      filter_button: "botão de filtro",
      sort_button: "botão de ordenar",
      first_card: "primeiro resultado",
    },
    dataOnly: false,
    defaultMetric: "pagina_produto",
    control: "A busca como está hoje",
    guardrails: ["buscas sem resultado", "uso de filtro nos resultados"],
    focus:
      "se o resultado responde o termo (o primeiro card é o que se buscou?), quantos resultados na primeira tela, filtros, o que acontece sem resultado, sugestões do campo",
  },
  pdp: {
    key: "pdp",
    label: "Página de produto",
    noun: "a PDP",
    description: "a página de produto (PDP)",
    areas: [
      "galeria",
      "titulo_preco",
      "tamanho",
      "botao_compra",
      "frete_entrega",
      "descricao",
      "leve_o_look",
      "recomendacoes",
      "confianca",
      "pagina_geral",
    ],
    parts: {
      price: "preço",
      size_selector: "seletor de tamanho",
      buy_button: "botão de compra",
      shipping: "frete",
      first_recommendation: "primeira vitrine de recomendação",
    },
    dataOnly: false,
    defaultMetric: "produto_carrinho",
    control: "A PDP como está hoje",
    guardrails: [
      "cliques mortos na PDP",
      "tempo até a primeira tela aparecer (LCP da PDP)",
    ],
    focus: "galeria, preço, tamanho, botão, frete, descrição, recomendações",
  },
  carrinho_checkout: {
    key: "carrinho_checkout",
    label: "Carrinho e checkout",
    noun: "o carrinho e o checkout",
    description:
      "o carrinho e o checkout (da plataforma, fora do site): abrir o carrinho, ir pro checkout, entrega, pagamento e compra. Não há print nem heatmap desta página: só o funil do GA4",
    areas: ["carrinho", "checkout", "pagina_geral"],
    parts: {},
    dataOnly: true,
    defaultMetric: "carrinho_checkout",
    control: "O carrinho e o checkout como estão hoje",
    guardrails: ["ticket médio", "taxa de aprovação do pagamento"],
    focus:
      "em qual etapa (carrinho → checkout → entrega → pagamento → compra) cai mais gente, e em qual dispositivo e canal",
  },
};

const isPageType = (v: unknown): v is UxPageType =>
  typeof v === "string" && Object.hasOwn(PAGE_TYPES, v);

/** Page type of any value (an old row with no value = PDP). */
export const asPageType = (v: unknown): UxPageType =>
  isPageType(v) ? v : "pdp";

export const pageSpec = (t: UxPageType | null | undefined): PageTypeSpec =>
  PAGE_TYPES[asPageType(t)];

/** All parts of all types → text; a part in several types keeps the first one's text. */
export const PART_WORD: Record<UxPart, string> = Object.assign(
  {},
  ...[...PAGE_TYPE_ORDER].reverse().map((t) => PAGE_TYPES[t].parts),
) as Record<UxPart, string>;

/** Text of the part on this page (the search's 1st card is "primeiro resultado"). */
export const partWord = (t: UxPageType, part: UxPart): string =>
  pageSpec(t).parts[part] ?? PART_WORD[part] ?? part;

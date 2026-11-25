/**
 * Contrato do diagnóstico de UI/UX — o módulo "PDP Optimizer" do menu.
 *
 * O módulo automatiza o processo que gerou `pdp-oportunidades.html`: retrato do
 * funil, onde está a perda, estado ao vivo da página, benchmark, e hipóteses no
 * formato fixo com Antes/Depois. Estes tipos são o que vai ao D1, o que a
 * Workflow passa de um step pro outro e o que o SPA lê — por isso snake_case,
 * igual ao resto de api/db.
 *
 * `page_type` existe desde a v1 (que era só PDP); desde 16/11 o diagnóstico
 * olha home, categoria, busca, PDP e carrinho/checkout (page-types.ts).
 */

import type { UxClaimLabel } from "./claims.ts";
import type { ExperimentDesign } from "./experiment.ts";
import type { UxFact } from "./facts.ts";
import type {
  HypothesisValidation,
  Lifecycle,
  LifecycleEntry,
  OpportunityOutcome,
} from "./lifecycle.ts";
import type { MeasuredMetric, UxMetricRef } from "./metrics.ts";
import type { HypothesisPriority } from "./priority.ts";
import type { ProbeResult } from "./probes.ts";
import type { HypothesisRelevance } from "./relevance.ts";
import type { DataReliability } from "./reliability.ts";
import type { HypothesisReview } from "./review.ts";
import type { Drilldown } from "./segments.ts";
import type {
  DiscardedCategory,
  HypothesisCategory,
  HypothesisTree,
} from "./tree.ts";
import type { HypothesisVerification } from "./verify/types.ts";

/** O tipo de página que um diagnóstico analisa (page-types.ts). */
export type UxPageType =
  | "home"
  | "categoria"
  | "busca"
  | "pdp"
  | "carrinho_checkout";

/** Uma parte medida na página real, de qualquer tipo de página (page-types.ts). */
export type UxPart =
  // PDP
  | "price"
  | "size_selector"
  | "buy_button"
  | "shipping"
  | "first_recommendation"
  // home
  | "hero"
  | "first_shelf"
  | "first_product"
  | "search_entry"
  | "menu_button"
  // categoria e busca
  | "page_title"
  | "filter_button"
  | "sort_button"
  | "first_card"
  | "load_more"
  | "results_count"
  | "search_field";

/**
 * Rotas de cada tipo de página no Deco Analytics (o `page` do heatmap), lidas
 * do `hmPages`. Categoria é uma lista: cada vitrine é uma rota própria e a
 * análise soma as mais vistas.
 */
export interface PageTemplates {
  home: string | null;
  busca: string | null;
  categoria: string[];
  detected_at: string;
}

export type UxDevice = "mobile" | "desktop";

// ── Perfil da loja ───────────────────────────────────────────────────────────

/**
 * Configuração da loja que o módulo analisa. É o que torna o módulo genérico:
 * nada de uma loja específica fica no código, tudo vem daqui.
 */
export interface SiteProfile {
  /** Domínio público da loja, sem protocolo (`www.loja.example`). */
  domain: string;
  /**
   * Slug do site no Deco Analytics (o `<site>` de
   * `/api/<org>/hosting/<site>/analytics/data`). NULL = usa o slug da org.
   */
  studio_site: string | null;
  /** Template de rota da PDP no Deco Analytics (`/:product/p` numa loja VTEX). */
  pdp_path_template: string;
  /** Rotas de home, busca e categoria. NULL = ainda não detectadas. */
  page_templates?: PageTemplates | null;
  /**
   * Concorrentes do benchmark. A primeira análise escolhe e grava aqui; vazio =
   * a próxima escolhe de novo (e trocar o domínio esvazia).
   */
  competitors: string[];
  /** Quando o cliente confirmou a lista; preenchido, o motor não a reescreve nem a completa. */
  competitors_confirmed_at: string | null;
  design_system: DesignSystem | null;
  design_system_at: string | null;
  /**
   * O tema como o código da loja nomeia (o repositório do site). Separado do
   * `design_system`: um vem do render, o outro do repo, e um falhar não apaga
   * o outro.
   */
  code_tokens: CodeTokens | null;
  /** De onde cada campo veio (Studio, binding…). NULL = perfil manual antigo. */
  sources: SiteSources | null;
  /**
   * Repo do site pro "ver no código" ("owner/nome"), quando o detectado não é
   * o que está no ar. NULL = usa `sources.repository`.
   */
  code_repo: string | null;
  /**
   * Projeto do site no Studio onde o "ver no código" abre a
   * sandbox — a mesma do editor de site. NULL = "ver no código" desligado.
   */
  code_project_id: string | null;
  /**
   * Volume do espelho do repo no org-fs do Studio. Só vale enquanto o deploy
   * não tem o STUDIO_SERVICE_TOKEN (verify/code-source.ts). NULL = sem espelho.
   */
  code_volume: string | null;
  updated_at: string;
}

/**
 * O que o diagnóstico achou sozinho no Studio: o projeto do site (domínio,
 * slug do Analytics, repo). A tela "Fontes" mostra isto; nada aqui foi
 * digitado por alguém.
 */
export interface SiteSources {
  detected_at: string;
  /** O Virtual MCP do site no Studio (metadata.siteSlug). */
  studio_project: {
    id: string;
    title: string;
    site_slug: string;
    domain: string | null;
    runtime: string | null;
  } | null;
  /**
   * O repositório do projeto do site (`metadata.repository`): o que a via de
   * repositórios do Studio lê (verify/code-source.ts). Sem provedor e host, GitHub.
   */
  repository: {
    owner: string;
    name: string;
    /** A conexão `mcp-github` do projeto, quando há. */
    connection_id: string | null;
    provider?: "github" | "gitlab" | "bitbucket";
    host?: string;
    /** O id do repositório no Studio (`repositoryId`), quando o projeto tem. */
    repository_id?: string;
  } | null;
  /** Erros de leitura das fontes, pra tela dizer o que faltou. */
  errors: string[];
}

export interface TextStyle {
  font_family: string;
  font_size: string;
  font_weight: string;
  line_height: string;
  letter_spacing: string;
  text_transform: string;
  color: string;
}

export interface BoxStyle extends TextStyle {
  background: string;
  border: string;
  border_radius: string;
  padding: string;
  height: string;
  /** Seletor CSS do elemento de onde o estilo foi lido (pra reproduzir). */
  selector: string;
  /** Texto visível do elemento, pra pessoa reconhecer o que é. */
  sample_text: string;
}

/**
 * O design system da loja, lido do site no ar (não do repositório): funciona
 * pra qualquer loja, inclusive as que não são deco. É o que impede o "Depois"
 * de sair "viajado" — o mockup só pode usar o que está aqui.
 */
export interface DesignSystem {
  source_url: string;
  captured_at: string;
  /** Custom properties do `:root`, as mais usadas primeiro. */
  css_variables: Record<string, string>;
  /** Cores por frequência de uso em texto, fundo e borda. */
  palette: Array<{ color: string; uses: number }>;
  fonts: string[];
  typography: {
    body: TextStyle | null;
    heading: TextStyle | null;
    price: TextStyle | null;
    link: TextStyle | null;
  };
  components: {
    primary_button: BoxStyle | null;
    secondary_button: BoxStyle | null;
    size_chip: BoxStyle | null;
    badge: BoxStyle | null;
    input: BoxStyle | null;
  };
  radii: string[];
  spacing: string[];
  /** Print do bloco de compra (preço, tamanho, botão), em R2. */
  buy_box_url: string | null;
}

/** Tema lido do repositório da loja (code-tokens.ts). */
export interface CodeTokens {
  /** `owner/repo` (via de repositórios do Studio) ou `<volume>@<org>` (espelho do org-fs). */
  repo: string;
  /** A hora da leitura (nenhum dos dois caminhos expõe o commit). */
  commit: string | null;
  read_at: string;
  files: string[];
  /** Declarações `--var: valor` dos CSS de entrada, sem modelo. */
  css_variables: Record<string, string>;
  /** Props das sections de Theme do `site.json` (deco), `grupo.chave → valor`. */
  theme: Record<string, string>;
  colors: Array<{ name: string; value: string; usage: string }>;
  fonts: Array<{ name: string; family: string }>;
  radii: Array<{ name: string; value: string }>;
  /** Stack e como se escreve botão/chip/preço com as classes da loja. */
  conventions: string | null;
  /** O modelo falhou: só a parte determinística saiu. */
  model_error?: string;
}

// ── Evidências ───────────────────────────────────────────────────────────────

/** Uma fonte que não respondeu. Vai pro relatório: buraco com nome. */
export interface SourceGap {
  source:
    | "lake"
    | "heatmap"
    | "bigquery"
    | "vtex"
    | "browser"
    | "benchmark"
    | "studio"
    | "github";
  error: string;
  /** O que o cliente tem que dar pra fechar a lacuna (com `owner: "customer"`). */
  key?: SetupKey;
  /** Quem fecha a lacuna. Ausente = nossa. */
  owner?: GapOwner;
}

/** O que o Plan pede ao cliente, nesta ordem. */
export type SetupKey =
  | "domain"
  | "competitors"
  | "analytics_install"
  | "bigquery"
  | "orders"
  /** Ligar o repositório do site no Studio, ou reconectar o provedor dele. */
  | "repository";

/** O cliente, a gente, ou alguém de fora (site que barra robô, VTEX pública). */
export type GapOwner = "customer" | "ours" | "external";

/** Funil do GA4 por plataforma (web, iOS, Android), contagem de eventos. */
export interface PlatformFunnel {
  platform: string;
  steps: Array<{ event: string; count: number }>;
}

/** Por onde se recorta o funil do GA4. */
export type SegmentDim = "canal" | "visitante" | "dia";

/**
 * O funil de uma plataforma dentro de um recorte: canal de aquisição
 * (`social_pago`, `direto`…), usuária `nova` × `recorrente`, ou um dia
 * (`20261110`). Usuárias distintas por evento, como o PlatformFunnel.
 */
export interface FunnelSegment {
  dim: SegmentDim;
  key: string;
  platform: string;
  steps: Array<{ event: string; count: number }>;
}

/** O funil de uma rota no GA4, por dispositivo (usuárias distintas). */
export interface Ga4PageFunnel {
  route: string;
  by_device: Array<{
    device: UxDevice;
    visitors: number;
    viewed: number;
    carted: number;
  }>;
}

/** Recorte da PDP num dispositivo, lido do Deco Analytics. */
export interface DevicePdpBehaviour {
  device: UxDevice;
  views: number;
  /** Rolagem média, % da altura da página. */
  avg_depth_pct: number;
  /** Quanto da página cabe na primeira tela, %. */
  avg_fold_pct: number;
  active_seconds: number;
  clicks: number;
  dead_clicks: number;
  /** % de quem chega a 25/50/75% da página. */
  reach: { p25: number; p50: number; p75: number };
  /**
   * % de quem chega a cada profundidade, de 5 em 5% (0, 5, …, 100). É o que
   * diz quantas pessoas veem uma parte que está a y px. Ausente = antes de 15/11.
   */
  scroll_curve?: Array<{ depth: number; reach_pct: number }>;
  /** Funil da página: quem entrou → viu produto → pôs no carrinho. */
  funnel: { visitors: number; viewed: number; carted: number } | null;
  /** Seções visuais da página com alcance, tempo e clique. */
  sections: Array<{
    section: string;
    reach_pct: number;
    avg_seconds: number;
    ctr_pct: number;
    clicks: number;
  }>;
  /**
   * Os elementos que mais concentram clique ou clique morto. Sem isto, clique
   * morto é só um total da página, que não diz onde a cliente se frustra.
   * Ausente em evidência anterior a 12/11.
   */
  elements?: PdpElementStat[];
}

/**
 * Um elemento clicado na PDP, do `hmElements` do Deco Analytics. `root` + `el`
 * é a identidade do coletor (shared/anchor.ts do repo analytics): a seção e o
 * hash do caminho até o elemento. O rótulo legível sai da captura, que calcula
 * o mesmo hash na página real (PageCapture.element_labels).
 */
export interface PdpElementStat {
  root: string;
  /** Hash do elemento, em decimal (é como o Studio devolve). */
  el: string;
  /** A seção, sem prefixo nem extensão ("Product/ProductDetails"). */
  section: string;
  clicks: number;
  /** Cliques sem nenhuma reação da página em 1 s. */
  dead: number;
  /** Dos cliques mortos, os que caíram num elemento clicável (botão, link). */
  dead_interactive: number;
  /** Quem clicou aqui e quantas dessas puseram no carrinho. NULL = sem funil. */
  funnel: { visitors: number; carted: number } | null;
}

export interface RevenueBase {
  window_days: number;
  /** Por canal de venda (VTEX sales channel). */
  by_channel: Array<{
    channel: string;
    orders: number;
    revenue: number;
    avg_ticket: number;
  }>;
  currency: string | null;
}

/** Produto que puxa tráfego e não vende — o insumo da fila de PDPs. */
export interface ProductSignal {
  product_id: string;
  name: string;
  url: string | null;
  views: number;
  orders: number;
  /** Pedidos por mil views. */
  orders_per_1k_views: number;
  availability: "alive" | "sold_out" | "broken_grid" | "unknown";
  available_skus: number;
  total_skus: number;
  reason:
    | "esgotado_com_trafego"
    | "grade_quebrada"
    | "nao_convence"
    | "converte_e_ninguem_ve";
}

/** Medidas de uma página real num dispositivo, tiradas no navegador. */
export interface PageCapture {
  device: UxDevice;
  /** Tipo da página capturada. Ausente = PDP. */
  page_type?: UxPageType;
  url: string;
  product_id: string | null;
  viewport: { width: number; height: number };
  page_height: number;
  fold_url: string | null;
  full_url: string | null;
  /**
   * Posição (px do topo) das partes que importam NESTE tipo de página (as da
   * PDP: preço, tamanho, botão…; as da categoria: filtro, 1º card…). NULL =
   * não achou; ausente = a parte não é deste tipo de página.
   */
  positions: Partial<Record<UxPart, number | null>>;
  /** Há barra de compra que fica fixa ao rolar? */
  has_sticky_buy: boolean;
  /** A página fala em esgotado/indisponível/avise-me. */
  sold_out_signal: boolean;
  /** Esboço textual do que aparece na primeira tela. */
  above_fold_outline: string[];
  /** Seletores CSS dos elementos medidos — o mockup usa pra saber onde mexer. */
  selectors: Partial<Record<UxPart, string | null>>;
  /**
   * Fatos da página fora da PDP, em número ou sim/não: cards na primeira
   * tela, cards por linha, total de resultados, altura do destaque… (lidos
   * por measureSitePageInPage). Ausente = PDP ou captura antiga.
   */
  facts?: Record<string, number | boolean | string | null>;
  /** HTML resumido do miolo da página, com as classes reais da loja. */
  dom_excerpt: string;
  /**
   * Estoque do produto capturado. Uma PDP esgotada mostra outra página (Avise-me,
   * tamanhos apagados), e o modelo desenhava solução de esgotado achando que era
   * a PDP comum. NULL/ausente = desconhecido.
   */
  stock?: ProductSignal["availability"] | null;
  /**
   * `root|el` → o que aquele elemento é nesta página, para os elementos de
   * `DevicePdpBehaviour.elements`. Ausente em captura anterior a 12/11.
   */
  element_labels?: Record<string, ElementLabel>;
}

export interface ElementLabel {
  /** `button "comprar"`, `label "PP"`, `img "Vestido..."`. */
  label: string;
  /** Topo do elemento, px do topo do documento. */
  y: number;
  /**
   * Pra onde o clique leva (link ou envio de formulário), ou ausente se não
   * troca de página. Clique morto aqui é, em geral, a página nova demorando
   * mais de 1 s, não um botão quebrado (page-scripts.ts, `navigationOf`).
   */
  navigates?: string;
  /** Não aparece na carga: está num painel que outro clique abre. O y não vale. */
  hidden?: boolean;
}

/**
 * Uma página de concorrente lida pro benchmark. O nome é da v1 (só PDP); hoje
 * é a página do mesmo tipo da analisada (home, categoria, busca ou PDP).
 */
export interface BenchmarkPdp {
  domain: string;
  /** Tipo da página capturada. Ausente = PDP. */
  page_type?: UxPageType;
  url: string;
  screenshot_url: string | null;
  /** Página inteira no celular (cortada no teto do modelo). NULL = cache antigo. */
  full_url: string | null;
  anatomy: {
    sticky_buy: boolean | null;
    size_above_fold: boolean | null;
    price_above_fold: boolean | null;
    shipping_estimate: boolean | null;
    wishlist: boolean | null;
    recommendation_position: string | null;
    notes: string;
    /**
     * O que a PDP faz em cada parte, numa frase lida do print. É o que deixa a
     * hipótese dizer "a loja X faz assim" sem inventar. Vazio = cache antigo.
     */
    by_area?: Partial<Record<UxArea, string>>;
  };
  captured_at: string;
}

export interface DiagnosisEvidence {
  window_days: number;
  platform_funnel: PlatformFunnel[];
  /** Recortes do funil do GA4. Ausente = antes de 15/11 ou a consulta falhou. */
  segments?: FunnelSegment[];
  /**
   * O comportamento da página ANALISADA no Deco Analytics (o nome é da v1, só
   * PDP; numa análise da home é a home). Vazio no carrinho/checkout.
   */
  pdp_behaviour: DevicePdpBehaviour[];
  /** Tipo da página analisada. Ausente = PDP (antes de 16/11). */
  page_type?: UxPageType;
  /** A rota do heatmap lida (`/buscar`, `/produtos/vestido`). */
  page_route?: string | null;
  /** As rotas deste tipo de página com views e rolagem (as categorias mais vistas). */
  routes?: Array<{ page: string; views: number; avg_depth: number }>;
  /** Busca: o termo que a captura buscou. */
  search_term?: string;
  /**
   * O funil da página analisada lido do GA4 (page_view → view_item →
   * add_to_cart na mesma sessão), quando o Deco Analytics não tem: lojas que
   * não mandam os eventos de produto e carrinho ao Deco Analytics. Ausente =
   * o Deco Analytics tem o funil, ou o GA4 não tem a rota.
   */
  ga4_page_funnel?: Ga4PageFunnel;
  revenue: RevenueBase | null;
  products: ProductSignal[];
  captures: PageCapture[];
  benchmark: BenchmarkPdp[];
  gaps: SourceGap[];
  /** Chave no R2 do snapshot do repo (`<org>/private/ux/<id>/repo.json`); ausente = não lido. */
  repo_snapshot_key?: string | null;
  /**
   * O livro de fatos (facts.ts), gravado no começo da análise pra que o F12
   * de uma hipótese aponte pro mesmo fato na verificação e no dossiê.
   * Ausente = evidência anterior a 19/11 (monta-se na hora).
   */
  facts?: UxFact[];
  /**
   * As sondas (probes.ts): camadas abertas sobre a 1ª tela e o que acontece
   * ao tocar nos elementos com clique morto. Ausente = antes de 19/11 ou a
   * análise rodou sem navegador.
   */
  probes?: ProbeResult[];
}

// ── Oportunidades ────────────────────────────────────────────────────────────

/**
 * Onde a oportunidade mora: uma parte da página analisada, a página inteira
 * (`pagina_geral`) ou outra página (`navegacao`, `carrinho_checkout`) — o funil
 * aponta perda antes e depois da página, e o modelo achava isso mesmo assim.
 * Cada tipo de página tem as suas partes (page-types.ts); a tela agrupa por
 * isto e a lista de valores fica em areas.ts.
 */
export type UxArea =
  // home
  | "home_destaque"
  | "home_vitrines"
  | "menu_busca"
  // categoria
  | "topo_categoria"
  | "card_produto"
  | "filtros_ordenacao"
  | "paginacao"
  // busca
  | "campo_busca"
  | "resultados_busca"
  | "busca_sem_resultado"
  // carrinho e checkout (só dados)
  | "carrinho"
  | "checkout"
  // PDP
  | "galeria"
  | "titulo_preco"
  | "tamanho"
  | "botao_compra"
  | "frete_entrega"
  | "descricao"
  | "leve_o_look"
  | "recomendacoes"
  | "confianca"
  | "pagina_geral"
  | "navegacao"
  | "carrinho_checkout";

/** Fonte de um número citado. Só vale fonte que respondeu nesta análise. */
export type UxSourceKind =
  | "ga4"
  | "deco_analytics"
  | "vtex"
  | "pagina"
  | "benchmark";

/** Um dado do "baseado em": GA4 · viu→carrinho no celular · 11,1% · 7 dias. */
export interface UxSourceRef {
  source: UxSourceKind;
  metric: string;
  /** Sempre com número. */
  value: string;
  window: string | null;
  /** Fato observado ou evidência indireta (claims.ts). Ausente = antes de 15/11. */
  label?: UxClaimLabel;
}

/** Uma observação da oportunidade e os fatos que ela cita (F12…). */
export interface UxObservation {
  text: string;
  facts: string[];
}

/**
 * Uma oportunidade da PDP: o problema, nomeado como conclusão, e os dados que
 * o mostram. O porquê e o que fazer ficam nas hipóteses dela.
 */
export interface UxOpportunity {
  id: string;
  diagnosis_id: string;
  rank: number;
  area: UxArea;
  /**
   * O título É o problema: a perda medida numa frase, montada em código
   * (losses.ts) — "No celular, 50,6% de quem entra em /produtos/promo não
   * abre nenhum produto". Nunca a causa. Antes de 16/11, texto do modelo.
   */
  title: string;
  /** Uma ou duas frases. */
  summary: string;
  device: UxDevice | "ambos";
  sources: UxSourceRef[];
  /** NULL = sem conta válida; a oportunidade fica, só sem valor. */
  money: MoneyEstimate | null;
  confidence: number;
  /** A etapa do funil que o problema afeta (o modelo escolhe). NULL = nenhuma. */
  metric?: UxMetricRef | null;
  /** A etapa medida em código nos dados desta análise. NULL = não deu. */
  measured?: MeasuredMetric | null;
  /** "Dá pra confiar nesses dados?" (reliability.ts). NULL = antes de 15/11. */
  reliability?: DataReliability | null;
  /** "O gap se repete?" nos recortes do GA4 (segments.ts). NULL = sem recorte. */
  drilldown?: Drilldown | null;
  /** As categorias da árvore que não viraram hipótese, e por quê. */
  tree_notes?: DiscardedCategory[] | null;
  /** Por que a investigação parou (lifecycle.ts). NULL = ainda rodando ou antiga. */
  outcome?: OpportunityOutcome | null;
  /**
   * O que o modelo viu na página e nos dados que pode explicar a perda — a
   * matéria-prima das hipóteses, não conclusão. Cada uma cita os fatos
   * (facts.ts) que a sustentam; sem fato que sustente, não entra. NULL =
   * antes de 16/11; `facts` vazio = antes de 19/11 (texto sem citação).
   */
  observations?: UxObservation[] | null;
  updated_at: string;
}

/** An opportunity before it is saved: the id comes from its diagnosis and rank. */
export type OpportunityDraft = Omit<
  UxOpportunity,
  "id" | "diagnosis_id" | "updated_at"
>;

/** Uma loja capturada no benchmark que já faz o que a hipótese propõe. */
export interface HypothesisBenchmark {
  domain: string;
  url: string | null;
  what_they_do: string;
}

// ── Hipóteses ────────────────────────────────────────────────────────────────

/**
 * A conta do dinheiro, sempre explícita. Mesma regra dos relatórios: o gap
 * total entra só como teto, nunca como promessa; a promessa é um delta pequeno
 * e nomeado sobre uma base nomeada.
 */
export interface MoneyEstimate {
  /** Em palavras: "1 ponto a mais em viu→carrinho no mobile". */
  assumption: string;
  /** Base (pessoas ou eventos por mês) sobre a qual o delta age. */
  base: number;
  base_label: string;
  /** Delta em pontos percentuais. */
  delta_pp: number;
  /** Valor de cada evento extra, em moeda. */
  value_per_event: number;
  value_label: string;
  /** base × delta × valor, por mês. */
  monthly_value: number;
  /** Teto: o gap inteiro, se a mudança fechasse tudo. Só referência. */
  ceiling_monthly: number | null;
  /** Fração do canal onde a mudança vale (site ≈ 1/3 numa loja de moda). */
  channel_share: number;
}

export type HypothesisStatus = "pending" | "approved" | "dismissed";

export type HypothesisKind = "proposta" | "nao_faria";

/**
 * Na v2, uma hipótese do PORQUÊ de uma oportunidade: `title` + `why` é a causa,
 * `evidence_md` são os sinais que a apoiam, `idea` + `where` é o que fazer, e
 * `benchmark` é quem já faz. Na v1 (sem `opportunity_id`) era problema, causa
 * e solução numa coisa só, com Antes/Depois.
 */
export interface UxHypothesis {
  id: string;
  diagnosis_id: string;
  /** NULL = v1, ou "o que eu não faria agora". */
  opportunity_id: string | null;
  rank: number;
  kind: HypothesisKind;
  /** O título é a conclusão ("Barra de compra fixa no celular"). */
  title: string;
  device: UxDevice | "ambos";
  /** O que os dados mostram — markdown curto, com números. */
  evidence_md: string;
  idea: string;
  why: string;
  /** Onde mexer: componente/seção da página. */
  where: string;
  money: MoneyEstimate | null;
  /** 0–1: quão forte é a evidência. */
  confidence: number;
  /** Domínios do benchmark que já fazem isso (v1). */
  benchmark_refs: string[];
  /** Lojas capturadas que já fazem isso, e como (v2). */
  benchmark: HypothesisBenchmark[];
  before_url: string | null;
  after_url: string | null;
  /** HTML/CSS injetado na página real pra gerar o "Depois". */
  after_patch: string | null;
  mockup_error: string | null;
  status: HypothesisStatus;
  status_note: string | null;
  /** "Ver no código" (desligado neste motor). NULL = nunca pedido. */
  code_status: CodeMockupStatus | null;
  code_note: string | null;
  code_before_url: string | null;
  code_after_url: string | null;
  /** `git diff` da mudança no repo da loja que gerou o Depois. */
  code_diff: string | null;
  code_error: string | null;
  code_started_at: string | null;
  /** Resultado do verificador. NULL = nunca verificada. */
  verification: HypothesisVerification | null;
  /** Categoria na árvore (tree.ts). Ausente = antes de 15/11. */
  category?: HypothesisCategory | null;
  /** "Se…, então…, porque…", a favor/contra, como refutar. Ausente = antes de 15/11. */
  tree?: HypothesisTree | null;
  /** Onde a evidência chegou (lifecycle.ts). Lido do veredito nas antigas. */
  lifecycle?: Lifecycle;
  lifecycle_log?: LifecycleEntry[];
  /** Os quatro níveis: existe, está no código, importa, é a causa. */
  validation?: HypothesisValidation | null;
  /** Quantas pessoas a mudança atinge (relevance.ts). NULL = não avaliada. */
  relevance?: HypothesisRelevance | null;
  /** O A/B recomendado (experiment.ts). NULL = sem relevância ou sem linha de base. */
  experiment?: ExperimentDesign | null;
  /** Prioridade de investigação e de teste (priority.ts). */
  priority?: HypothesisPriority | null;
  /** Revisão independente (review.ts). NULL = não revisada. */
  review?: HypothesisReview | null;
  updated_at: string;
}

export type CodeMockupStatus = "running" | "done" | "error";

// ── Diagnóstico ──────────────────────────────────────────────────────────────

export type DiagnosisStatus = "running" | "done" | "error";

export type DiagnosisStage =
  | "queued"
  | "collect"
  | "capture"
  | "benchmark"
  | "opportunities"
  | "hypotheses"
  | "verify"
  /** Quantas pessoas cada mudança atinge (relevance.ts). */
  | "relevance"
  /** Só v1: os diagnósticos antigos pararam aqui. */
  | "mockups"
  | "done";

export interface DiagnosisSummary {
  /** Duas ou três frases: onde está o dinheiro. */
  headline: string;
  /** Limites da análise (associação ≠ causa, fontes que faltaram). */
  limits: string[];
  /**
   * id da oportunidade → por que as hipóteses dela não saíram (a chamada
   * falhou). A tela da oportunidade mostra isso no lugar das hipóteses.
   */
  hypothesis_notes?: Record<string, string>;
  /**
   * Hipóteses que a verificação desmentiu, com a prova. A linha delas sai
   * do banco (e a oportunidade que esvazia cai): sem isto, os testes e os
   * prints sumiam junto e sobrava uma frase no rodapé. Ausente nos de antes
   * de 13/11.
   */
  refuted?: RefutedHypothesis[];
}

export interface RefutedHypothesis {
  opportunity_title: string;
  hypothesis_title: string;
  /** A causa que a hipótese afirmava. */
  why: string;
  verification: HypothesisVerification;
}

export interface UxDiagnosis {
  id: string;
  page_type: UxPageType;
  /** Rodada de que este diagnóstico faz parte. NULL = anterior às rodadas. */
  site_run_id?: string | null;
  /** A meta com que a rodada começou (fica mesmo se a meta mudar). */
  goal_id?: string | null;
  /** O texto da meta: entra no prompt das hipóteses e no dossiê. */
  objective_statement?: string | null;
  status: DiagnosisStatus;
  stage: DiagnosisStage;
  /** "3 de 5 mockups" etc. — só pra tela de progresso. */
  progress_note: string | null;
  domain: string;
  summary: DiagnosisSummary | null;
  evidence: DiagnosisEvidence | null;
  error: string | null;
  cost_usd: number | null;
  started_at: string;
  finished_at: string | null;
}

/** Linha da lista (sem as evidências, que são grandes). */
export type UxDiagnosisListItem = Omit<UxDiagnosis, "evidence"> & {
  opportunities_total: number;
  hypotheses_total: number;
  hypotheses_approved: number;
};

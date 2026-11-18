/**
 * Placeholder report until the full analysis exists. The labels stand in for
 * data the analysis will return, so they are not UI copy.
 */

export type CheckStatus = "missing" | "partial" | "done";

export interface MapNode {
  id: string;
  label: string;
  status?: CheckStatus;
  /** An area the agents do not cover yet. */
  soon?: boolean;
  note?: string;
  /** The outcome this area moves, shown instead of a checklist score. */
  metric?: { value: string; label: string };
  /** Sessions that reached this funnel stage. */
  sessions?: number;
  /** Stages sharing a step are alternative paths, like a category page or a search. */
  step?: number;
  /** A page on the store that shows this stage. */
  path?: string;
  /** Orders placed at the end of the funnel. */
  orders?: number;
  /** What the agents found on a funnel stage's page. */
  opportunities?: MapNode[];
  children?: MapNode[];
}

function leaf(
  id: string,
  label: string,
  status: CheckStatus,
  note?: string,
): MapNode {
  return { id, label, status, note };
}

export const MOCK_SITE_MAP: MapNode = {
  id: "root",
  label: "Minha loja",
  children: [
    {
      id: "inbound",
      label: "Inbound",
      metric: { value: "182 mil", label: "sessões orgânicas em 30 dias" },
      children: [
        {
          id: "seo",
          label: "SEO",
          metric: { value: "48 mil", label: "cliques no Google em 30 dias" },
          children: [
            leaf("sitemap", "Sitemap", "done"),
            leaf("robots", "Robots.txt", "done"),
            leaf(
              "canonical",
              "Canonical",
              "partial",
              "Páginas de categoria com filtros apontam o canonical para a própria URL filtrada.",
            ),
            leaf(
              "meta-tags",
              "Meta tags",
              "partial",
              "Títulos duplicados em parte das páginas de produto.",
            ),
            leaf(
              "structured-data",
              "Dados estruturados",
              "missing",
              "Páginas de produto sem schema Product e Offer.",
            ),
            leaf(
              "broken-links",
              "Links quebrados",
              "missing",
              "Links internos retornando 404 no menu e no rodapé.",
            ),
            leaf(
              "hreflang",
              "Hreflang",
              "missing",
              "Versões em outros idiomas sem hreflang.",
            ),
          ],
        },
        {
          id: "geo",
          label: "GEO",
          metric: {
            value: "1,2 mil",
            label: "cliques vindos de IA em 30 dias",
          },
          children: [
            leaf(
              "llms-txt",
              "llms.txt",
              "missing",
              "Nenhum llms.txt publicado para orientar assistentes de IA.",
            ),
            leaf("ai-bots", "Bots de IA liberados", "done"),
            leaf(
              "ai-data",
              "Dados para IA",
              "partial",
              "Preço e disponibilidade só aparecem após o carregamento do JavaScript.",
            ),
            leaf(
              "faq",
              "FAQ nas PDPs",
              "missing",
              "Sem perguntas frequentes nas páginas de produto.",
            ),
          ],
        },
        {
          id: "content",
          label: "Conteúdo",
          metric: { value: "12 mil", label: "sessões no blog em 30 dias" },
          children: [
            leaf(
              "blog",
              "Blog",
              "partial",
              "Último post publicado há 4 meses.",
            ),
            leaf("size-guide", "Guia de medidas", "done"),
            leaf(
              "category-copy",
              "Textos de categoria",
              "missing",
              "Categorias principais sem texto descritivo.",
            ),
          ],
        },
      ],
    },
    {
      id: "cro",
      label: "CRO",
      metric: { value: "1,4%", label: "de conversão em 30 dias" },
      orders: 5_900,
      children: [
        {
          id: "stage-home",
          label: "Home",
          step: 1,
          sessions: 420_000,
          path: "/",
          opportunities: [
            leaf(
              "hero-banner",
              "Banner principal",
              "partial",
              "O banner principal leva para uma coleção esgotada.",
            ),
            leaf(
              "personal-shelves",
              "Vitrines personalizadas",
              "missing",
              "Todos os clientes veem as mesmas vitrines.",
            ),
            leaf("visible-search", "Busca visível", "done"),
          ],
        },
        {
          id: "stage-plp",
          label: "PLP",
          step: 2,
          sessions: 190_000,
          path: "/feminino",
          opportunities: [
            leaf(
              "filters",
              "Filtros",
              "partial",
              "Filtros de tamanho e cor não combinam entre si.",
            ),
            leaf(
              "plp-sort",
              "Ordenação",
              "missing",
              "A ordenação padrão mostra primeiro produtos sem estoque.",
            ),
            leaf("plp-pagination", "Carregar mais", "done"),
          ],
        },
        {
          id: "stage-search",
          label: "Busca",
          step: 2,
          sessions: 70_000,
          path: "/s?q=vestido",
          opportunities: [
            leaf("autocomplete", "Autocomplete", "done"),
            leaf(
              "no-results",
              "Sem resultados",
              "missing",
              "A página sem resultados não sugere alternativas.",
            ),
            leaf("synonyms", "Sinônimos", "done"),
          ],
        },
        {
          id: "stage-product",
          label: "Produto",
          step: 3,
          sessions: 180_000,
          path: "/vestido-midi-floral/p",
          opportunities: [
            leaf("gallery", "Galeria", "done"),
            leaf(
              "delivery-estimate",
              "Prazo de entrega",
              "missing",
              "O prazo só aparece no checkout.",
            ),
            leaf(
              "reviews",
              "Avaliações",
              "partial",
              "Avaliações carregam abaixo da dobra e sem nota média no topo.",
            ),
            leaf(
              "buy-together",
              "Compre junto",
              "partial",
              "Sem sugestão de produtos complementares.",
            ),
            leaf("size-table", "Tabela de medidas", "done"),
          ],
        },
        {
          id: "stage-cart",
          label: "Carrinho",
          step: 4,
          sessions: 21_600,
          path: "/checkout/#/cart",
          opportunities: [
            leaf(
              "free-shipping-bar",
              "Barra de frete grátis",
              "missing",
              "O cliente não vê quanto falta para o frete grátis.",
            ),
            leaf("cart-coupon", "Cupom no carrinho", "done"),
            leaf(
              "cart-recommendations",
              "Recomendações",
              "partial",
              "Recomendações genéricas, sem relação com os itens do carrinho.",
            ),
          ],
        },
        {
          id: "stage-checkout",
          label: "Checkout",
          step: 5,
          sessions: 11_900,
          path: "/checkout",
          opportunities: [
            leaf(
              "steps",
              "Etapas",
              "partial",
              "Cadastro obrigatório antes do pagamento.",
            ),
            leaf("pix", "Pix", "done"),
            leaf(
              "social-login",
              "Login social",
              "missing",
              "Sem login com Google ou Apple.",
            ),
          ],
        },
      ],
    },
    { id: "tracking", label: "Tracking", soon: true },
    { id: "promotions", label: "Promoções e cupons", soon: true },
    { id: "outbound", label: "Outbound", soon: true },
    {
      id: "technical",
      label: "Saúde técnica",
      children: [
        {
          id: "speed",
          label: "Velocidade",
          children: [
            leaf("lcp", "LCP", "done"),
            leaf("inp", "INP", "done"),
            leaf(
              "cls",
              "CLS",
              "missing",
              "Banners sem altura reservada empurram o conteúdo.",
            ),
            leaf("images", "Imagens", "done"),
            leaf(
              "third-party",
              "Scripts de terceiros",
              "missing",
              "Oito scripts de terceiros bloqueiam a renderização.",
            ),
            leaf("cache", "Cache", "done"),
          ],
        },
        {
          id: "accessibility",
          label: "Acessibilidade",
          children: [
            leaf(
              "contrast",
              "Contraste",
              "partial",
              "Preços promocionais em cinza claro sobre fundo branco.",
            ),
            leaf(
              "alt-text",
              "Texto alternativo",
              "missing",
              "Imagens de produto sem texto alternativo.",
            ),
            leaf(
              "keyboard",
              "Navegação por teclado",
              "partial",
              "O menu não abre pelo teclado.",
            ),
            leaf(
              "form-labels",
              "Rótulos de formulário",
              "missing",
              "Campos do newsletter e do CEP sem rótulo.",
            ),
            leaf("touch-targets", "Áreas de toque", "done"),
          ],
        },
        {
          id: "best-practices",
          label: "Boas práticas",
          children: [
            leaf("https", "HTTPS", "done"),
            leaf(
              "console-errors",
              "Erros no console",
              "partial",
              "Erros de JavaScript em páginas de produto.",
            ),
            leaf(
              "outdated-libs",
              "Bibliotecas desatualizadas",
              "missing",
              "Bibliotecas com vulnerabilidades conhecidas.",
            ),
            leaf("image-ratio", "Proporção das imagens", "done"),
          ],
        },
      ],
    },
  ],
};

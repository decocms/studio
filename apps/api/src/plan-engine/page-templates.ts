/**
 * Que rota do Deco Analytics é cada tipo de página. O heatmap responde por
 * rota (`page=/buscar`), e todo payload traz `hmPages`: as rotas mais vistas
 * do site com views e rolagem. Daqui sai a home, a busca e as categorias, sem
 * ninguém digitar nada (numa loja de moda, 16/11: `/`, `/buscar`, `/colecao/promo`,
 * `/novidades`, `/colecao/vestidos`, `/bazar`…).
 *
 * Categoria não é um template: cada vitrine é uma rota. A análise lê o heatmap
 * da mais vista (é a que a captura abre, pra os elementos baterem) e passa as
 * outras como resumo (`PageRoute`).
 */

import type { HeatmapPayload } from "./ports.ts";
import type { PageTemplates, UxPageType } from "./types.ts";

/** Uma rota do site com o tráfego dela (somado nos dispositivos). */
export interface PageRoute {
  page: string;
  views: number;
  /** Rolagem média, % da altura, ponderada por views. */
  avg_depth: number;
}

/** Quantas rotas de categoria o perfil guarda. */
export const MAX_CATEGORY_ROUTES = 8;

const SEARCH_ROUTE = /^\/(s|busca|buscar|search|pesquisa)(\/|$)/i;

/** Rotas que não são vitrine: conta, carrinho, institucional, blog… */
const NOT_A_LISTING =
  /^\/(checkout|cart|carrinho|sacola|account|conta|minha-conta|login|wishlist|favoritos|lista-de-desejos|institucional|ajuda|atendimento|faq|lojas|nossas-lojas|blog|politica|trocas|sobre|contato|api|_)/i;

/** Rota com parâmetro (`/:product/p`) é template de página de detalhe. */
const HAS_PARAM = /\/:/;

/** `hmPages` → rotas somadas nos dispositivos, mais vistas primeiro. */
export function routesFromPages(
  pages: NonNullable<HeatmapPayload["data"]["hmPages"]>,
): PageRoute[] {
  const by = new Map<string, { views: number; depthViews: number }>();
  for (const p of pages) {
    const page = String(p.page_key ?? "").trim();
    const views = Number(p.views) || 0;
    if (!page.startsWith("/") || views <= 0) continue;
    const cur = by.get(page) ?? { views: 0, depthViews: 0 };
    cur.views += views;
    cur.depthViews += views * (Number(p.avg_depth) || 0);
    by.set(page, cur);
  }
  return [...by.entries()]
    .map(([page, v]) => ({
      page,
      views: v.views,
      avg_depth: Math.round((v.depthViews / v.views) * 10) / 10,
    }))
    .sort((a, b) => b.views - a.views);
}

/** Home, busca e as categorias mais vistas, a partir das rotas do site. */
export function detectPageTemplates(
  routes: PageRoute[],
  pdpTemplate: string,
  now: string,
): PageTemplates {
  const home = routes.find((r) => r.page === "/")?.page ?? null;
  const busca = routes.find((r) => SEARCH_ROUTE.test(r.page))?.page ?? null;
  const categoria = routes
    .filter(
      (r) =>
        r.page !== "/" &&
        r.page !== pdpTemplate &&
        !SEARCH_ROUTE.test(r.page) &&
        !HAS_PARAM.test(r.page) &&
        !NOT_A_LISTING.test(r.page),
    )
    .slice(0, MAX_CATEGORY_ROUTES)
    .map((r) => r.page);
  return { home, busca, categoria, detected_at: now };
}

/** A rota do heatmap pra este tipo de página. NULL = não há (checkout) ou não achou. */
export function heatmapRouteFor(
  pageType: UxPageType,
  pdpTemplate: string,
  templates: PageTemplates | null | undefined,
): string | null {
  switch (pageType) {
    case "pdp":
      return pdpTemplate;
    case "home":
      return templates?.home ?? "/";
    case "busca":
      return templates?.busca ?? null;
    case "categoria":
      return templates?.categoria[0] ?? null;
    case "carrinho_checkout":
      return null;
  }
}

/** Rotas detectadas há mais de uma semana são lidas de novo. */
export const TEMPLATES_MAX_AGE_DAYS = 7;

export function templatesAreStale(
  t: PageTemplates | null | undefined,
  now = Date.now(),
): boolean {
  return (
    !t?.detected_at ||
    now - Date.parse(t.detected_at) > TEMPLATES_MAX_AGE_DAYS * 86_400_000
  );
}

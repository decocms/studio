/**
 * Which Deco Analytics route is each page type. The heatmap answers per route
 * (`page=/buscar`) and every payload carries `hmPages`: the site's most-viewed
 * routes with views and scroll, so home, search and categories need no manual
 * input. A category is not a template: each listing is a route; the analysis
 * reads the most-viewed one's heatmap and passes the others as a summary
 * (`PageRoute`).
 */

import type { HeatmapPayload } from "./ports.ts";
import type { PageTemplates, UxPageType } from "./types.ts";

/** A site route with its traffic (summed across devices). */
export interface PageRoute {
  page: string;
  views: number;
  /** Average scroll, % of height, weighted by views. */
  avg_depth: number;
}

/** How many category routes the profile keeps. */
const MAX_CATEGORY_ROUTES = 8;

const SEARCH_ROUTE = /^\/(s|busca|buscar|search|pesquisa)(\/|$)/i;

/** Routes that are not listings: account, cart, institutional, blog... */
const NOT_A_LISTING =
  /^\/(checkout|cart|carrinho|sacola|account|conta|minha-conta|login|wishlist|favoritos|lista-de-desejos|institucional|ajuda|atendimento|faq|lojas|nossas-lojas|blog|politica|trocas|sobre|contato|api|_)/i;

/** A route with a parameter (`/:product/p`) is a detail page template. */
const HAS_PARAM = /\/:/;

/** `hmPages` -> routes summed across devices, most viewed first. */
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

/** Home, search and the most-viewed categories, from the site's routes. */
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

/** The heatmap route for this page type. NULL = none (checkout) or not found. */
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

/** Routes detected more than a week ago are re-read. */
const TEMPLATES_MAX_AGE_DAYS = 7;

export function templatesAreStale(
  t: PageTemplates | null | undefined,
  now = Date.now(),
): boolean {
  return (
    !t?.detected_at ||
    now - Date.parse(t.detected_at) > TEMPLATES_MAX_AGE_DAYS * 86_400_000
  );
}

/**
 * Find a PDP, listing and search on any store (benchmark). The Chrome-side
 * scripts only collect raw links and forms; the decisions live here so they are
 * testable without a browser.
 */

import { sameStore } from "./domain-check.ts";

/** Where the link is on the page: menu and main area count more than footer. */
export type LinkZone = "nav" | "header" | "main" | "footer" | "other";

/** An `<a href>` as the page saw it (href already absolute). */
export interface RawLink {
  href: string;
  zone: LinkZone;
  text: string;
  /** Has a photo inside: product or category card. */
  image: boolean;
}

export interface StoreLinks {
  /** Looks like a PDP by URL pattern. */
  pdp: string[];
  /** Maybe a PDP: only counts once opened and confirmed by structured data. */
  maybePdp: string[];
  /** Listing (category, collection): menu first, footer last. */
  listing: string[];
}

/** PDP URL patterns; `/products/<handle>` only at the root, with a language prefix or inside /collections/x/. */
const PDP_PATTERN =
  /(\/p$|\/p\/|\/product\/|\/produto\/|\/produtos\/[^/]+\/?$|^(\/[a-z]{2}(-[a-z]{2})?)?\/products\/[^/]+\/?$|\/collections\/[^/]+\/products\/[^/]+|\/prd\/|-p-\d|-p\d{6,}\.html$|\/dp\/|\/item\/|^\/[a-z0-9-]+\/[a-z]*\d{3,}[a-z0-9]*\.html$)/i;

/** `<three-word-slug>.html`: a PDP on Magento, but categories also use `.html`. */
const HTML_SLUG = /^\/([a-z0-9]+-){2,}[a-z0-9]+\.html$/i;

/** Slug that names a collection or campaign, not a product. */
const LISTING_WORDS =
  /(^|-)(colecao|collection|categoria|category|departamento|department|outlet|sale|promo\w*|liquida\w*|novidades|lancamentos|look|lookbook|campanha|marca|brand)(-|$)/i;

/** Pages that are neither product nor listing. */
const SKIP =
  /(^|[/_-])(login|entrar|conta|minha-conta|account|my-account|cart|carrinho|sacola|checkout|store-locator|lojas|nossas-lojas|ajuda|help|faq|politica\w*|policy|privac\w*|termos|terms|blog|contato|contact|wishlist|favoritos|institucional|sobre|about|quem-somos|trocas?|devoluc\w*|atendimento|rastre\w*|cadastro|register|newsletter|trabalhe-conosco|carreiras|careers|imprensa|search|busca|buscar|pesquisa|catalogsearch)([/_.-]|$)/i;

/** A file, not a page. */
const FILE = /\.(pdf|jpe?g|png|gif|webp|svg|xml|txt|zip|json|js|css)$/i;

const ZONE_ORDER: Record<LinkZone, number> = {
  nav: 0,
  header: 1,
  main: 2,
  other: 3,
  footer: 4,
};

const LIMIT = 12;

/** Path segments, without the language prefix (`/pt-br/`). */
function segmentsOf(pathname: string): string[] {
  const segs = pathname.split("/").filter(Boolean);
  return segs.length > 1 && /^[a-z]{2}(-[a-z]{2})?$/i.test(segs[0] ?? "")
    ? segs.slice(1)
    : segs;
}

/** What kind of page the path looks like. */
export function classifyPath(
  pathname: string,
  hint: { image?: boolean; zone?: LinkZone } = {},
): "pdp" | "maybe" | "listing" | null {
  if (pathname === "/" || SKIP.test(pathname) || FILE.test(pathname))
    return null;
  if (PDP_PATTERN.test(pathname)) return "pdp";
  const segs = segmentsOf(pathname);
  const last = segs[segs.length - 1] ?? "";
  if (HTML_SLUG.test(`/${last}`) && !LISTING_WORDS.test(last)) return "maybe";
  // A loose slug (`/basic-cotton-tee`): a product when it looks like a product name and shows up as a photo card, or ends in a code.
  if (segs.length <= 2 && !LISTING_WORDS.test(last)) {
    const words = last
      .replace(/\.html$/i, "")
      .split("-")
      .filter(Boolean);
    const coded = words.length >= 2 && /^\d{4,}$/.test(words.at(-1) ?? "");
    const card =
      words.length >= 3 &&
      hint.image === true &&
      (hint.zone === "main" || hint.zone === "other");
    if (coded || card) return "maybe";
  }
  return segs.length <= 3 ? "listing" : null;
}

/** Key of an internal URL (origin + path), or null if it is external. */
function internalKey(href: string, origin: string): string | null {
  let url: URL;
  let base: URL;
  try {
    url = new URL(href, origin);
    base = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!sameStore(url.hostname, base.hostname)) return null;
  return `${url.origin}${url.pathname}`;
}

/** A store page's links in three buckets: PDP by URL, maybe-PDP (needs confirmation), and listings to descend into. */
export function classifyStoreLinks(
  links: readonly RawLink[],
  origin: string,
): StoreLinks {
  const pdp: string[] = [];
  const maybe: string[] = [];
  const listing: Array<{ key: string; zone: LinkZone; at: number }> = [];
  const seen = new Set<string>();
  links.forEach((link, at) => {
    const key = internalKey(link.href, origin);
    if (!key || seen.has(key)) return;
    const kind = classifyPath(new URL(key).pathname, link);
    if (!kind) return;
    seen.add(key);
    if (kind === "pdp") pdp.push(key);
    else if (kind === "maybe") maybe.push(key);
    else listing.push({ key, zone: link.zone, at });
  });
  listing.sort(
    (a, b) => ZONE_ORDER[a.zone] - ZONE_ORDER[b.zone] || a.at - b.at,
  );
  return {
    pdp: pdp.slice(0, LIMIT),
    maybePdp: maybe.slice(0, LIMIT),
    listing: listing.slice(0, LIMIT).map((l) => l.key),
  };
}

/** How many products the page lists (PDP pattern or product card). */
export function productCount(links: StoreLinks): number {
  return links.pdp.length + links.maybePdp.length;
}

/** A page with 4+ products is a listing or search result. */
export const MIN_LISTED_PRODUCTS = 4;

/** Menu item that is not a product type. */
const NOT_A_TERM =
  /^(menu|home|in[ií]cio|entrar|login|conta|sacola|carrinho|ver tudo|ver mais|todos|todas|sale|outlet|novidades|lan[cç]amentos|promo[cç](ão|ões)|ofertas|marcas|blog|ajuda|contato|lojas)$/i;

/** A search term taken from the store's own menu (first product-type item), for when its term finds nothing at the competitor. */
export function termFromLinks(
  links: readonly RawLink[],
  origin: string,
): string | null {
  const ordered = links
    .map((link, at) => ({ link, at }))
    .filter(({ link }) => link.zone !== "footer")
    .sort(
      (a, b) =>
        ZONE_ORDER[a.link.zone] - ZONE_ORDER[b.link.zone] || a.at - b.at,
    );
  for (const { link } of ordered) {
    const key = internalKey(link.href, origin);
    if (!key) continue;
    const path = new URL(key).pathname;
    if (classifyPath(path, link) !== "listing") continue;
    const text = link.text.replace(/\s+/g, " ").trim().toLowerCase();
    const fromPath = (segmentsOf(path).at(-1) ?? "")
      .replace(/\.html$/i, "")
      .replace(/-/g, " ")
      .toLowerCase();
    for (const candidate of [text, fromPath]) {
      if (candidate.length < 3 || candidate.length > 24) continue;
      if (!/^\p{L}+( \p{L}+)?$/u.test(candidate)) continue;
      if (NOT_A_TERM.test(candidate)) continue;
      return candidate;
    }
  }
  return null;
}

// ── Search ───────────────────────────────────────────────────────────────────

/** A page `<form>`: `action` as in the HTML, named inputs. */
export interface RawSearchForm {
  action: string;
  method: string;
  inputs: Array<{ name: string; type: string; value: string }>;
}

export interface SearchHints {
  /** URL of the page where the forms were (base for relative actions). */
  pageUrl: string;
  forms: RawSearchForm[];
  /** Start of the HTML, to recognize the platform. */
  html: string;
}

export type Platform =
  | "vtex-io"
  | "vtex-legacy"
  | "magento"
  | "shopify"
  | "deco"
  | "nuvemshop"
  | "vnda";

/** The store's platform from the traces it leaves in the HTML; null = unknown. */
export function detectPlatform(html: string): Platform | null {
  if (/render-runtime|__RUNTIME__|\/_v\/segment\/|vtex\.store-/i.test(html))
    return "vtex-io";
  if (/deco\.cx|decocdn|\/live\/invoke|\/deco\/render|_frsh/i.test(html))
    return "deco";
  if (
    /vtex\.js|vtexcommercestable|vteximg\.com\.br|\/arquivos\/[\w.-]+\.js/i.test(
      html,
    )
  )
    return "vtex-legacy";
  if (/Magento_|mage\/cookies|data-mage-init|x-magento-init/i.test(html))
    return "magento";
  if (/cdn\.shopify\.com|Shopify\.theme/i.test(html)) return "shopify";
  if (/nuvemshop|tiendanube/i.test(html)) return "nuvemshop";
  if (/cdn\.vnda|vnda\.com\.br/i.test(html)) return "vnda";
  return null;
}

/** Each platform's search route; `{q}` is the term. */
const PLATFORM_SEARCH_ROUTES: Record<Platform, string[]> = {
  "vtex-io": ["/{q}?_q={q}&map=ft"],
  "vtex-legacy": ["/busca?ft={q}"],
  magento: ["/catalogsearch/result/?q={q}"],
  shopify: ["/search?q={q}"],
  deco: ["/s?q={q}"],
  nuvemshop: ["/search/?q={q}"],
  vnda: ["/busca?q={q}"],
};

/** No recognized platform: from the most common to the rarest. */
const COMMON_SEARCH_ROUTES = [
  "/search?q={q}",
  "/s?q={q}",
  "/busca?q={q}",
  "/{q}?_q={q}&map=ft",
  "/busca?ft={q}",
  "/catalogsearch/result/?q={q}",
  "/buscar?q={q}",
  "/pesquisa?q={q}",
];

/** Field name that is the search box. */
const SEARCH_INPUT_NAME =
  /^(q|_q|query|ft|search|busca|buscar|term|termo|keyword|s)$/i;

/** The page's search form route (`{q}` for the term), or null. GET only; relative actions resolve against the page, cross-domain ones are ignored. */
export function searchRouteFromForms(
  forms: readonly RawSearchForm[],
  pageUrl: string,
): string | null {
  for (const form of forms) {
    if (form.method && form.method.toLowerCase() !== "get") continue;
    const box =
      form.inputs.find((i) => i.type.toLowerCase() === "search" && i.name) ??
      form.inputs.find(
        (i) =>
          SEARCH_INPUT_NAME.test(i.name) && /^(text|search|)$/i.test(i.type),
      );
    if (!box) continue;
    let action: URL;
    try {
      action = new URL(form.action || pageUrl, pageUrl);
    } catch {
      continue;
    }
    if (!sameStore(action.hostname, new URL(pageUrl).hostname)) continue;
    action.hash = "";
    action.searchParams.delete(box.name);
    for (const hidden of form.inputs) {
      if (hidden.type.toLowerCase() === "hidden" && hidden.name)
        action.searchParams.set(hidden.name, hidden.value);
    }
    const sep = action.search ? "&" : "?";
    return `${action.href}${sep}${encodeURIComponent(box.name)}={q}`;
  }
  return null;
}

/** Search routes to try, in order: the home form's, the recognized platform's, then common ones. Absolute, deduplicated. */
export function searchRoutes(hints: SearchHints): string[] {
  const origin = new URL(hints.pageUrl).origin;
  const platform = detectPlatform(hints.html);
  const out: string[] = [];
  const push = (route: string | null) => {
    if (!route) return;
    const abs = route.startsWith("/") ? `${origin}${route}` : route;
    if (!out.includes(abs)) out.push(abs);
  };
  push(searchRouteFromForms(hints.forms, hints.pageUrl));
  for (const route of platform ? PLATFORM_SEARCH_ROUTES[platform] : [])
    push(route);
  for (const route of COMMON_SEARCH_ROUTES) push(route);
  return out;
}

/** The route with the term. */
export function fillRoute(route: string, term: string): string {
  return route.replaceAll("{q}", encodeURIComponent(term));
}

/** The route as it shows up in the gap: path and query only, without the term. */
export function routeLabel(route: string): string {
  try {
    const u = new URL(route.replaceAll("{q}", "QQ"));
    return `${u.pathname}${u.search}`.replaceAll("QQ", "…");
  } catch {
    return route;
  }
}

/** Landed on the home, without the term in the URL (some stores' `/?s=term` is valid). */
function sentHome(landed: string, term: string): boolean {
  try {
    const u = new URL(landed);
    return (
      u.pathname === "/" &&
      !fold(decodeURIComponent(u.search)).includes(fold(term))
    );
  } catch {
    return false;
  }
}

/**
 * What a search route returned: `ok` lists products, `missing` the route does
 * not exist, `no_results` the search found nothing, `no_product_links` it
 * answered by the term but with no recognizable product link.
 */
export type SearchOutcome =
  | "ok"
  | "missing"
  | "no_results"
  | "no_product_links";

/** On the accent-free text (`fold`). */
const NO_RESULTS =
  /nenhum (produto|resultado|item)|nao (encontramos|achamos|encontrou)|nao (foi|foram) encontrad|sem resultados?|(^|[^\d])0 (produtos|resultados|itens|results)|nao ha produtos|no results|no products? found|nothing found/gi;

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

export function searchOutcome(r: {
  status: number;
  links: StoreLinks;
  /** Page content text. */
  text: string;
  /** Title, h1 and search box: where the search repeats the term. */
  heading: string;
  term: string;
  /** Final URL: an unknown route that redirects to the home is not the search. */
  landed?: string;
}): SearchOutcome {
  if (r.status === 404 || r.status === 410) return "missing";
  if (r.landed && sentHome(r.landed, r.term)) return "missing";
  if (productCount(r.links) >= MIN_LISTED_PRODUCTS) return "ok";
  if (r.status >= 400) return "missing";
  const term = fold(r.term);
  // "Nenhum produto" alone can be an empty cart; it only counts near the term.
  const text = fold(r.text);
  const empty = [...text.matchAll(NO_RESULTS)];
  const emptyNearTerm = empty.some((m) =>
    text
      .slice(Math.max(0, m.index - 100), m.index + m[0].length + 100)
      .includes(term),
  );
  const echoed = fold(r.heading).includes(term);
  if (emptyNearTerm || (echoed && empty.length > 0)) return "no_results";
  if (echoed) return "no_product_links";
  return "missing";
}

export interface SearchAttempt {
  /** The route's `routeLabel`. */
  route: string;
  term: string;
  outcome: SearchOutcome;
}

/** The gap for a search that produced no page, naming the step that failed. */
export function searchFailureMessage(
  domain: string,
  attempts: readonly SearchAttempt[],
  outOfTime: boolean,
): string {
  const late = outOfTime ? "; acabou o tempo antes das outras rotas" : "";
  if (attempts.length === 0) return `sem tempo pra testar a busca de ${domain}`;
  const noLinks = attempts.find((a) => a.outcome === "no_product_links");
  if (noLinks) {
    return `a busca de ${domain} respondeu pra "${noLinks.term}" em ${noLinks.route}, mas sem link de produto reconhecível`;
  }
  const empty = attempts.filter((a) => a.outcome === "no_results");
  if (empty.length > 0) {
    const terms = [...new Set(empty.map((a) => `"${a.term}"`))].join(
      " nem pra ",
    );
    return `a busca de ${domain} (${empty[0]?.route}) não achou produto pra ${terms}`;
  }
  const routes = [...new Set(attempts.map((a) => a.route))].join(", ");
  return `rota de busca de ${domain} não encontrada (testadas: ${routes})${late}`;
}

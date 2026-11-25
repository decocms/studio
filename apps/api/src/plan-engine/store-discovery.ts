/**
 * Achar PDP, vitrine e busca numa loja qualquer (benchmark).
 *
 * O que roda no Chrome (`storeLinksInPage` e `searchHintsInPage`, em
 * page-scripts.ts) só junta links e formulários crus; a decisão mora aqui, fora
 * da página, pra ser testável sem navegador.
 */

import { sameStore } from "./domain-check.ts";

/** Onde o link está na página: menu e área principal valem mais que rodapé. */
export type LinkZone = "nav" | "header" | "main" | "footer" | "other";

/** Um `<a href>` como a página o viu (href já absoluto). */
export interface RawLink {
  href: string;
  zone: LinkZone;
  text: string;
  /** Tem foto dentro: card de produto ou de categoria. */
  image: boolean;
}

export interface StoreLinks {
  /** Cara de PDP pelo padrão da URL. */
  pdp: string[];
  /**
   * Talvez PDP: slug longo com foto na área principal, `<slug>.html`. Só vale
   * depois de aberta e confirmada pelos dados estruturados.
   */
  maybePdp: string[];
  /** Vitrine (categoria, coleção): menu primeiro, rodapé por último. */
  listing: string[];
}

/**
 * Padrões de URL de PDP. `/products/<handle>` só na raiz (ou com prefixo de
 * idioma, ou dentro de /collections/x/): `/content/products/editorial` e
 * `/mobile/products/br/…` passavam e custaram ~3 min de páginas que não são PDP.
 */
const PDP_PATTERN =
  /(\/p$|\/p\/|\/product\/|\/produto\/|\/produtos\/[^/]+\/?$|^(\/[a-z]{2}(-[a-z]{2})?)?\/products\/[^/]+\/?$|\/collections\/[^/]+\/products\/[^/]+|\/prd\/|-p-\d|-p\d{6,}\.html$|\/dp\/|\/item\/|^\/[a-z0-9-]+\/[a-z]*\d{3,}[a-z0-9]*\.html$)/i;

/** `<slug-de-tres-palavras>.html`: PDP no Magento, mas categoria também usa `.html`. */
const HTML_SLUG = /^\/([a-z0-9]+-){2,}[a-z0-9]+\.html$/i;

/** Slug que nomeia coleção ou campanha, não produto. */
const LISTING_WORDS =
  /(^|-)(colecao|collection|categoria|category|departamento|department|outlet|sale|promo\w*|liquida\w*|novidades|lancamentos|look|lookbook|campanha|marca|brand)(-|$)/i;

/** Páginas que não são produto nem vitrine. */
const SKIP =
  /(^|[/_-])(login|entrar|conta|minha-conta|account|my-account|cart|carrinho|sacola|checkout|store-locator|lojas|nossas-lojas|ajuda|help|faq|politica\w*|policy|privac\w*|termos|terms|blog|contato|contact|wishlist|favoritos|institucional|sobre|about|quem-somos|trocas?|devoluc\w*|atendimento|rastre\w*|cadastro|register|newsletter|trabalhe-conosco|carreiras|careers|imprensa|search|busca|buscar|pesquisa|catalogsearch)([/_.-]|$)/i;

/** Arquivo, não página. */
const FILE = /\.(pdf|jpe?g|png|gif|webp|svg|xml|txt|zip|json|js|css)$/i;

const ZONE_ORDER: Record<LinkZone, number> = {
  nav: 0,
  header: 1,
  main: 2,
  other: 3,
  footer: 4,
};

const LIMIT = 12;

/** Segmentos do caminho, sem o prefixo de idioma (`/pt-br/`). */
function segmentsOf(pathname: string): string[] {
  const segs = pathname.split("/").filter(Boolean);
  return segs.length > 1 && /^[a-z]{2}(-[a-z]{2})?$/i.test(segs[0] ?? "")
    ? segs.slice(1)
    : segs;
}

/** Que tipo de página o caminho parece ser. */
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
  // Slug solto (`/camiseta-basica-algodao`): produto quando tem cara de nome
  // de produto e aparece como card com foto, ou termina num código.
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

/** Chave de uma URL interna (origem + caminho), ou null se for de fora. */
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

/**
 * Links de uma página da loja em três baldes: PDP pelo padrão da URL, talvez
 * PDP (só confirmada), e vitrines pra descer um nível quando a home não lista
 * produto (o comum: muita home só tem categorias).
 */
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

/** Quantos produtos a página lista (padrão de PDP ou card de produto). */
export function productCount(links: StoreLinks): number {
  return links.pdp.length + links.maybePdp.length;
}

/** Uma página com 4+ produtos é vitrine ou resultado de busca. */
const MIN_LISTED_PRODUCTS = 4;

/** Item de menu que não é tipo de produto. */
const NOT_A_TERM =
  /^(menu|home|in[ií]cio|entrar|login|conta|sacola|carrinho|ver tudo|ver mais|todos|todas|sale|outlet|novidades|lan[cç]amentos|promo[cç](ão|ões)|ofertas|marcas|blog|ajuda|contato|lojas)$/i;

/**
 * Um termo de busca tirado da própria loja: o primeiro item do menu com cara de
 * tipo de produto ("vestidos", "tênis"). Serve quando o termo da loja analisada
 * não acha nada no concorrente, que pode nem vender aquilo.
 */
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

// ── Busca ────────────────────────────────────────────────────────────────────

/** Um `<form>` da página: `action` como está no HTML, inputs com nome. */
export interface RawSearchForm {
  action: string;
  method: string;
  inputs: Array<{ name: string; type: string; value: string }>;
}

export interface SearchHints {
  /** URL da página onde os formulários estavam (base das actions relativas). */
  pageUrl: string;
  forms: RawSearchForm[];
  /** Começo do HTML, pra reconhecer a plataforma. */
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

/** A plataforma da loja pelos rastros que ela deixa no HTML; null = não sei. */
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

/**
 * A rota de busca de cada plataforma; `{q}` é o termo. `/s?q=` é a do deco,
 * `/busca?ft=` a do VTEX legado e `/<termo>?_q=<termo>&map=ft` a do VTEX IO.
 */
const PLATFORM_SEARCH_ROUTES: Record<Platform, string[]> = {
  "vtex-io": ["/{q}?_q={q}&map=ft"],
  "vtex-legacy": ["/busca?ft={q}"],
  magento: ["/catalogsearch/result/?q={q}"],
  shopify: ["/search?q={q}"],
  deco: ["/s?q={q}"],
  nuvemshop: ["/search/?q={q}"],
  vnda: ["/busca?q={q}"],
};

/** Sem plataforma reconhecida: das mais comuns às mais raras. */
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

/** Nome de campo que é a caixa de busca. */
const SEARCH_INPUT_NAME =
  /^(q|_q|query|ft|search|busca|buscar|term|termo|keyword|s)$/i;

/**
 * A rota do formulário de busca da página (`{q}` no lugar do termo), ou null.
 * Só GET: um POST não vira URL. Action relativa resolve contra a página; de
 * outro domínio não serve (a captura é da loja).
 */
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

/**
 * As rotas de busca a tentar, em ordem: a do formulário da home (é a da loja,
 * com certeza), a da plataforma reconhecida e as comuns. Absolutas, sem repetir.
 */
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

/** A rota com o termo. */
export function fillRoute(route: string, term: string): string {
  return route.replaceAll("{q}", encodeURIComponent(term));
}

/** A rota como aparece na lacuna: só caminho e query, sem o termo. */
export function routeLabel(route: string): string {
  try {
    const u = new URL(route.replaceAll("{q}", "QQ"));
    return `${u.pathname}${u.search}`.replaceAll("QQ", "…");
  } catch {
    return route;
  }
}

/** Caiu na home, sem o termo na URL (o `/?s=termo` de algumas lojas vale). */
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
 * O que uma rota de busca devolveu:
 * - `ok`: lista produtos;
 * - `missing`: a rota não existe (404, volta pra home, ou página que não
 *   responde pelo termo);
 * - `no_results`: a busca existe e diz que não achou nada;
 * - `no_product_links`: a busca respondeu pelo termo, mas sem link de produto
 *   que a gente reconheça.
 */
export type SearchOutcome =
  | "ok"
  | "missing"
  | "no_results"
  | "no_product_links";

/** Sobre o texto sem acento (`fold`). */
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
  /** Texto do conteúdo da página. */
  text: string;
  /** Título, h1 e caixa de busca: onde a busca repete o termo. */
  heading: string;
  term: string;
  /** URL final: rota desconhecida que redireciona pra home não é a busca. */
  landed?: string;
}): SearchOutcome {
  if (r.status === 404 || r.status === 410) return "missing";
  if (r.landed && sentHome(r.landed, r.term)) return "missing";
  if (productCount(r.links) >= MIN_LISTED_PRODUCTS) return "ok";
  if (r.status >= 400) return "missing";
  const term = fold(r.term);
  // "Nenhum produto" sozinho pode ser o carrinho vazio; vale perto do termo.
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
  /** `routeLabel` da rota. */
  route: string;
  term: string;
  outcome: SearchOutcome;
}

/** A lacuna da busca que não deu página, nomeando a etapa que falhou. */
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

/**
 * Benchmark: how other stores' pages handle what ours does not. Starts from the
 * profile's list, asks the model for more when short, captures each on mobile and
 * reads what it does per area. Results are cached for 30 days.
 */

import { areasForPrompt, asArea, isAreaOfPage } from "./areas.ts";
import {
  BotWallError,
  browserFetcher,
  type Fetcher,
  openPage,
  PageOpenError,
  screenshotFold,
  screenshotFull,
  storeImage,
} from "./browser.ts";
import { sameStore } from "./domain-check.ts";
import { extractJsonObject } from "./json.ts";
import {
  isProductPageInPage,
  searchHintsInPage,
  storeLinksInPage,
} from "./page-scripts.ts";
import { pageSpec } from "./page-types.ts";
import type {
  BrowserPage,
  BrowserPort,
  Llm,
  LlmTier,
  LlmUsage,
  MediaStore,
} from "./ports.ts";
import { SITEMAP_FETCH, sitemapCandidates } from "./sitemap.ts";
import {
  classifyStoreLinks,
  fillRoute,
  MIN_LISTED_PRODUCTS,
  productCount,
  type RawLink,
  routeLabel,
  type SearchAttempt,
  type SearchHints,
  type SearchOutcome,
  searchFailureMessage,
  searchOutcome,
  searchRoutes,
  type StoreLinks,
  termFromLinks,
} from "./store-discovery.ts";
import type { BenchmarkPdp, UxArea, UxPageType } from "./types.ts";

/** A reading task, not a judgement. */
const BENCHMARK_MODEL: LlmTier = "smart";

/** How many stores the benchmark compares. */
export const MAX_COMPETITORS = 5;

/**
 * How many stores to ask the model for: more than MAX_COMPETITORS, since some
 * suggestions do not open (anti-bot wall, no PDP, a look-alike domain).
 */
const MAX_CANDIDATES = 8;

/** Normalizes what the user or the model wrote into a clean domain. */
export function normalizeDomain(raw: string): string | null {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

/**
 * Competitors the model suggests: same segment, a good mobile PDP, and open to an
 * automated browser. Each item names brand and products so the model commits to
 * the right store instead of guessing a look-alike domain.
 */
export async function suggestCompetitors(opts: {
  llm: Llm;
  domain: string;
  storeDescription: string;
  /** Stores already listed or already failed in this run. */
  exclude?: string[];
  onUsage: (u: LlmUsage) => void;
}): Promise<string[]> {
  const exclude = [opts.domain, ...(opts.exclude ?? [])];
  const raw = await opts.llm(
    {
      tier: BENCHMARK_MODEL,
      maxTokens: 1_000,
      temperature: 0.2,
      systemPrompt:
        "Você é especialista em e-commerce de moda e varejo. Responda só JSON.",
      userPrompt: `Loja analisada: ${opts.domain}
O que a home dela diz: ${opts.storeDescription.slice(0, 600)}

Liste ${MAX_CANDIDATES} lojas online que vendem o MESMO tipo de produto que essa loja, cuja página de produto no celular é referência de boa experiência de compra.
- Prefira lojas do mesmo país da loja analisada; no máximo 2 internacionais.
- Evite gigantes internacionais de moda e marketplaces globais: costumam bloquear navegador automático.
- Só o domínio oficial da loja online, que existe e vende direto. Confira que o domínio é DA MARCA (nome parecido de outra empresa não serve).
- Não repita: ${exclude.join(", ")}.

Formato: {"stores": [{"domain": "exemplo.com.br", "brand": "Exemplo", "sells": "moda feminina"}, ...]}`,
    },
    opts.onUsage,
  );
  const json = extractJsonObject(raw);
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as { stores?: unknown; domains?: unknown };
    const items = Array.isArray(parsed.stores)
      ? parsed.stores
      : Array.isArray(parsed.domains)
        ? parsed.domains
        : [];
    const out: string[] = [];
    for (const item of items) {
      const value =
        item && typeof item === "object" && "domain" in item
          ? item.domain
          : item;
      const d = normalizeDomain(String(value ?? ""));
      if (!d) continue;
      if (exclude.some((e) => sameStore(e, d))) continue;
      if (out.some((o) => sameStore(o, d))) continue;
      out.push(d);
    }
    return out.slice(0, MAX_CANDIDATES);
  } catch {
    return [];
  }
}

/**
 * The home's title and description, so the model can suggest same-segment
 * competitors without us naming the segment.
 */
export async function storeDescription(
  browser: BrowserPort,
  domain: string,
): Promise<string> {
  try {
    const res = await browser.fetch(`https://${domain}/`, {
      maxBytes: 200_000,
      timeoutMs: 15_000,
      userAgent: "Mozilla/5.0 (compatible; plan-engine)",
    });
    const html = res.body;
    const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "";
    const description =
      html.match(
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
      )?.[1] ?? "";
    return `${title.trim()} — ${description.trim()}`;
  } catch {
    return domain;
  }
}

/**
 * Competitors open without `?html=1`, which is only for the analysed store (forceHtml).
 */
function openCompetitor(
  browser: BrowserPort,
  url: string,
  onStatus?: (status: number) => void,
): Promise<BrowserPage> {
  return openPage(browser, url, "mobile", { ownStore: false, onStatus });
}

/**
 * Part of the per-store cap kept for screenshots and reading the page found: the
 * search stops earlier, with a gap saying how far it got.
 */
const CAPTURE_RESERVE_MS = 40_000;
/** Home listings opened looking for products. */
const MAX_LISTINGS = 3;
/** PDP candidates opened until one confirms. */
const MAX_PDP_TRIES = 4;

const hasTime = (deadline: number | undefined) =>
  deadline === undefined || Date.now() < deadline;

/** Sitemaps are read from where the browser runs, unless a test hands its own. */
const sitemapFetcher = (browser: BrowserPort, fetcher: Fetcher | undefined) =>
  fetcher ?? browserFetcher(browser, SITEMAP_FETCH);

/** The page's links, classified outside it (store-discovery.ts). */
async function readLinks(page: BrowserPage): Promise<{
  origin: string;
  raw: RawLink[];
  text: string;
  heading: string;
  links: StoreLinks;
}> {
  const snap = await page.evaluate(storeLinksInPage);
  return {
    origin: snap.origin,
    raw: snap.links,
    text: snap.text,
    heading: snap.heading,
    links: classifyStoreLinks(snap.links, snap.origin),
  };
}

/**
 * Opens a URL that may not exist (listing, sitemap candidate, search route):
 * one that fails is skipped; an anti-bot wall or a browser crash propagates.
 */
async function openOrSkip(
  open: (url: string) => Promise<BrowserPage>,
  url: string,
): Promise<BrowserPage | null> {
  try {
    return await open(url);
  } catch (err) {
    if (!(err instanceof PageOpenError)) throw err;
    console.warn(`[plan-engine] benchmark pulando ${url}: ${err.message}`);
    return null;
  }
}

/**
 * An anti-bot challenge that keeps reloading breaks reading with a browser
 * message that means nothing on the limits screen.
 */
function asBotWall(err: unknown, url: string): unknown {
  const msg = err instanceof Error ? err.message : String(err);
  return /Execution context was destroyed/i.test(msg)
    ? new BotWallError("página que não para de recarregar", url)
    : err;
}

/**
 * PDP candidates from a home, most likely first, opening listings only when the
 * consumer asks for more: home PDP links, then listings' links, then the sitemap.
 * Callers confirm each one by its structured data.
 */
export async function* pdpCandidates(
  browser: BrowserPort,
  homeUrl: string,
  opts: { ownStore: boolean; deadline?: number; fetcher?: Fetcher },
): AsyncGenerator<string, void> {
  const open = (url: string) =>
    openPage(browser, url, "mobile", { ownStore: opts.ownStore });
  const seen = new Set<string>();
  const fresh = (urls: readonly string[]) => {
    const out: string[] = [];
    for (const u of urls) {
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
    return out;
  };
  const later: string[] = [];
  const fromPage = (links: StoreLinks) => {
    if (links.maybePdp.length >= MIN_LISTED_PRODUCTS)
      return [...links.pdp, ...links.maybePdp];
    later.push(...links.maybePdp);
    return links.pdp;
  };

  const home = await open(homeUrl);
  let found: Awaited<ReturnType<typeof readLinks>>;
  try {
    found = await readLinks(home);
  } finally {
    await home.close().catch(() => {});
  }
  yield* fresh(fromPage(found.links));

  for (const listing of found.links.listing.slice(0, MAX_LISTINGS)) {
    if (!hasTime(opts.deadline)) return;
    const page = await openOrSkip(open, listing);
    if (!page) continue;
    let inner: StoreLinks;
    try {
      inner = (await readLinks(page)).links;
    } finally {
      await page.close().catch(() => {});
    }
    yield* fresh(fromPage(inner));
  }

  if (!hasTime(opts.deadline)) return;
  yield* fresh(
    await sitemapCandidates(
      found.origin,
      "pdp",
      sitemapFetcher(browser, opts.fetcher),
    ),
  );
  yield* fresh(later);
}

/** What a competitor capture needs from outside. */
interface CompetitorOpts {
  browser: BrowserPort;
  media: MediaStore;
  llm: Llm;
  /** A URL the model can download, from a media path. */
  mediaUrl: (path: string) => Promise<string>;
  domain: string;
  keyPrefix: string;
  now: string;
  /**
   * The per-store cap: the search stops early to keep time for the screenshot.
   */
  budgetMs: number;
  onUsage: (u: LlmUsage) => void;
  fetcher?: Fetcher;
}

/**
 * Opens the competitor's home, follows PDP candidates until one declares Product
 * (JSON-LD, microdata or og:type), takes the mobile screenshot and reads the anatomy.
 */
export async function captureCompetitorPdp(
  opts: CompetitorOpts,
): Promise<BenchmarkPdp> {
  try {
    return await capturePdp(opts);
  } catch (err) {
    throw asBotWall(err, `https://${opts.domain}/`);
  }
}

async function capturePdp(opts: CompetitorOpts): Promise<BenchmarkPdp> {
  const deadline = Date.now() + opts.budgetMs - CAPTURE_RESERVE_MS;
  let found = 0;
  let opened = 0;
  for await (const url of pdpCandidates(
    opts.browser,
    `https://${opts.domain}/`,
    { ownStore: false, deadline, fetcher: opts.fetcher },
  )) {
    found++;
    if (opened >= MAX_PDP_TRIES || !hasTime(deadline)) break;
    const page = await openOrSkip((u) => openCompetitor(opts.browser, u), url);
    if (!page) continue;
    opened++;
    try {
      if (!(await page.evaluate(isProductPageInPage))) continue;
      const fold = await screenshotFold(page);
      const screenshotUrl = await storeImage(
        opts.media,
        `${opts.keyPrefix}/${opts.domain}.jpg`,
        fold,
      );
      const fullUrl = await storeImage(
        opts.media,
        `${opts.keyPrefix}/${opts.domain}-full.jpg`,
        await screenshotFull(page),
      );
      const anatomy = await readAnatomy({
        llm: opts.llm,
        images: [
          await opts.mediaUrl(screenshotUrl),
          await opts.mediaUrl(fullUrl),
        ],
        outline: await page.evaluate(() =>
          (document.body.innerText ?? "").replace(/\s+/g, " ").slice(0, 5000),
        ),
        onUsage: opts.onUsage,
      });
      return {
        domain: opts.domain,
        url,
        screenshot_url: screenshotUrl,
        full_url: fullUrl,
        anatomy,
        captured_at: opts.now,
      };
    } finally {
      await page.close().catch(() => {});
    }
  }
  const late = hasTime(deadline) ? "" : "; acabou o tempo";
  if (found === 0) {
    throw new Error(
      `nenhum link de produto em ${opts.domain} (home, vitrines e sitemap${late})`,
    );
  }
  throw new Error(
    `nenhuma página de produto confirmada em ${opts.domain}: ${opened} aberta(s), nenhuma com dados de produto (JSON-LD, microdata ou og:type)${late}`,
  );
}

async function readAnatomy(opts: {
  llm: Llm;
  /** First screen and full page, in that order. */
  images: [string, string];
  outline: string;
  onUsage: (u: LlmUsage) => void;
}): Promise<BenchmarkPdp["anatomy"]> {
  const raw = await opts.llm(
    {
      tier: BENCHMARK_MODEL,
      maxTokens: 1500,
      temperature: 0,
      systemPrompt:
        "Você analisa a página de produto de uma loja no celular. Responda só JSON. Não invente: se a imagem e o texto não mostram, use null (ou deixe a parte de fora).",
      userPrompt: `A 1ª imagem é a primeira tela (390×844) da página de produto; a 2ª é a página inteira (cortada). Texto da página, pra conferir: """${opts.outline}"""

Partes da página:
${areasForPrompt({ pdpOnly: true })}

Responda:
{
  "sticky_buy": true|false|null,        // há barra/botão de compra fixo no rodapé ou topo?
  "size_above_fold": true|false|null,   // os tamanhos aparecem sem rolar?
  "price_above_fold": true|false|null,
  "shipping_estimate": true|false|null, // mostra prazo/frete sem pedir CEP?
  "wishlist": true|false|null,          // há salvar/favoritar visível?
  "recommendation_position": "string|null", // onde aparece a primeira vitrine de outros produtos (ex. "logo abaixo do botão", "depois da descrição")
  "notes": "uma frase com o que essa PDP faz de diferente",
  "by_area": { "<parte>": "uma frase concreta com o que esta PDP faz nessa parte (ex.: 'galeria em carrossel horizontal com 8 fotos e vídeo na 2ª posição')" }
}
Em by_area, só as partes que aparecem nas imagens ou no texto.`,
      contentParts: opts.images.map((url) => ({ type: "image" as const, url })),
    },
    opts.onUsage,
  );
  const json = extractJsonObject(raw);
  const fallback: BenchmarkPdp["anatomy"] = {
    sticky_buy: null,
    size_above_fold: null,
    price_above_fold: null,
    shipping_estimate: null,
    wishlist: null,
    recommendation_position: null,
    notes: "",
    by_area: {},
  };
  if (!json) return fallback;
  try {
    const p = JSON.parse(json) as Record<string, unknown>;
    const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
    return {
      sticky_buy: bool(p.sticky_buy),
      size_above_fold: bool(p.size_above_fold),
      price_above_fold: bool(p.price_above_fold),
      shipping_estimate: bool(p.shipping_estimate),
      wishlist: bool(p.wishlist),
      recommendation_position:
        typeof p.recommendation_position === "string"
          ? p.recommendation_position
          : null,
      notes: typeof p.notes === "string" ? p.notes : "",
      by_area: parseByArea(p.by_area),
    };
  } catch {
    return fallback;
  }
}

function parseByArea(
  v: unknown,
  pageType: UxPageType = "pdp",
): Partial<Record<UxArea, string>> {
  const out: Partial<Record<UxArea, string>> = {};
  if (!v || typeof v !== "object") return out;
  for (const [key, text] of Object.entries(v)) {
    const area = asArea(key);
    if (area !== key || !isAreaOfPage(area, pageType)) continue;
    if (typeof text !== "string" || !text.trim()) continue;
    out[area] = text.trim();
  }
  return out;
}

// ── Benchmark of home, listing and search ────────────────────────────────────

type Found = { page: BrowserPage; url: string };

/** The first URL that lists products; the others are closed. */
async function firstListing(
  browser: BrowserPort,
  urls: readonly string[],
  deadline: number,
): Promise<{ hit: Found | null; opened: number }> {
  let opened = 0;
  for (const url of urls) {
    if (!hasTime(deadline)) break;
    const page = await openOrSkip((u) => openCompetitor(browser, u), url);
    if (!page) continue;
    opened++;
    try {
      const { links } = await readLinks(page);
      if (productCount(links) >= MIN_LISTED_PRODUCTS)
        return { hit: { page, url }, opened };
    } catch (err) {
      await page.close().catch(() => {});
      throw asBotWall(err, url);
    }
    await page.close().catch(() => {});
  }
  return { hit: null, opened };
}

/**
 * A competitor listing: the home's (menu before footer), else the sitemap's categories.
 */
export async function findListingPage(
  browser: BrowserPort,
  domain: string,
  deadline: number,
  fetcher?: Fetcher,
): Promise<Found> {
  const homePage = await openCompetitor(browser, `https://${domain}/`);
  let home: Awaited<ReturnType<typeof readLinks>>;
  try {
    home = await readLinks(homePage);
  } finally {
    await homePage.close().catch(() => {});
  }
  const listings = home.links.listing.slice(0, MAX_LISTINGS);
  const fromHome = await firstListing(browser, listings, deadline);
  if (fromHome.hit) return fromHome.hit;
  const sitemap = hasTime(deadline)
    ? (
        await sitemapCandidates(
          home.origin,
          "listing",
          sitemapFetcher(browser, fetcher),
        )
      )
        .filter((u) => !listings.includes(u))
        .slice(0, MAX_LISTINGS)
    : [];
  const fromSitemap = await firstListing(browser, sitemap, deadline);
  if (fromSitemap.hit) return fromSitemap.hit;
  if (listings.length === 0 && sitemap.length === 0) {
    throw new Error(`nenhuma vitrine na home nem no sitemap de ${domain}`);
  }
  throw new Error(
    `nenhuma vitrine com produtos em ${domain} (${fromHome.opened} da home e ${fromSitemap.opened} do sitemap abertas${hasTime(deadline) ? "" : "; acabou o tempo"})`,
  );
}

/**
 * Search routes tried per store: the form's, the platform's, the common ones.
 */
const MAX_SEARCH_ROUTES = 5;

/**
 * The competitor's search: form, platform and common routes until one lists
 * products. If our term finds nothing, retries once with a term from its menu.
 * A route that fails does not end the others; an anti-bot wall ends the store.
 */
export async function findSearchPage(
  browser: BrowserPort,
  domain: string,
  storeTerm: string | null,
  deadline: number,
): Promise<Found> {
  const homePage = await openCompetitor(browser, `https://${domain}/`);
  let home: Awaited<ReturnType<typeof readLinks>>;
  let hints: SearchHints;
  try {
    home = await readLinks(homePage);
    hints = await homePage.evaluate(searchHintsInPage);
  } finally {
    await homePage.close().catch(() => {});
  }
  const terms: string[] = [];
  for (const t of [storeTerm?.trim(), termFromLinks(home.raw, home.origin)]) {
    if (t && !terms.some((x) => x.toLowerCase() === t.toLowerCase()))
      terms.push(t);
  }
  const [first, second] = terms;
  if (!first) {
    throw new Error(
      `sem termo de busca pra comparar (nem da loja, nem do menu de ${domain})`,
    );
  }

  const attempts: SearchAttempt[] = [];
  const tryRoute = async (route: string, term: string) => {
    const url = fillRoute(route, term);
    let status = 0;
    const page = await openOrSkip(
      (u) =>
        openCompetitor(browser, u, (s) => {
          status = s;
        }),
      url,
    );
    let outcome: SearchOutcome = "missing";
    if (page) {
      try {
        const { links, text, heading } = await readLinks(page);
        outcome = searchOutcome({
          status,
          links,
          text,
          heading,
          term,
          landed: page.url(),
        });
      } catch (err) {
        await page.close().catch(() => {});
        throw err;
      }
      if (outcome === "ok") return { found: { page, url }, outcome };
      await page.close().catch(() => {});
    }
    attempts.push({ route: routeLabel(route), term, outcome });
    return { found: null, outcome };
  };

  let answered: string | null = null;
  for (const route of searchRoutes(hints).slice(0, MAX_SEARCH_ROUTES)) {
    if (!hasTime(deadline)) break;
    const r = await tryRoute(route, first);
    if (r.found) return r.found;
    if (r.outcome !== "missing") {
      answered = route;
      break;
    }
  }
  if (answered && second && hasTime(deadline)) {
    const r = await tryRoute(answered, second);
    if (r.found) return r.found;
  }
  throw new Error(searchFailureMessage(domain, attempts, !hasTime(deadline)));
}

/**
 * The competitor's page of our page's type (home, a listing that lists products,
 * or search): a mobile screenshot and what it does in each area.
 */
export async function captureCompetitorPage(
  opts: CompetitorOpts & {
    pageType: Exclude<UxPageType, "pdp" | "carrinho_checkout">;
    searchTerm: string | null;
  },
): Promise<BenchmarkPdp> {
  const deadline = Date.now() + opts.budgetMs - CAPTURE_RESERVE_MS;
  const home = `https://${opts.domain}/`;
  let found: Found;
  try {
    found =
      opts.pageType === "home"
        ? { page: await openCompetitor(opts.browser, home), url: home }
        : opts.pageType === "busca"
          ? await findSearchPage(
              opts.browser,
              opts.domain,
              opts.searchTerm,
              deadline,
            )
          : await findListingPage(
              opts.browser,
              opts.domain,
              deadline,
              opts.fetcher,
            );
  } catch (err) {
    throw asBotWall(err, home);
  }
  try {
    return await readCompetitorPage(found, opts);
  } catch (err) {
    throw asBotWall(err, found.url);
  } finally {
    await found.page.close().catch(() => {});
  }
}

/** Screenshot and reading of the page found. */
async function readCompetitorPage(
  { page, url }: Found,
  opts: Parameters<typeof captureCompetitorPage>[0],
): Promise<BenchmarkPdp> {
  const spec = pageSpec(opts.pageType);
  const slug = `${opts.domain}-${opts.pageType}`;
  const screenshotUrl = await storeImage(
    opts.media,
    `${opts.keyPrefix}/${slug}.jpg`,
    await screenshotFold(page),
  );
  const fullUrl = await storeImage(
    opts.media,
    `${opts.keyPrefix}/${slug}-full.jpg`,
    await screenshotFull(page),
  );
  const pageText = (
    await page.evaluate(() =>
      (document.body.innerText ?? "").replace(/\s+/g, " ").slice(0, 5000),
    )
  ).replace(/"""/g, "");
  const raw = await opts.llm(
    {
      tier: BENCHMARK_MODEL,
      maxTokens: 1500,
      temperature: 0,
      systemPrompt: `Você analisa ${spec.noun} de uma loja no celular (${spec.description}). Responda só JSON. Não invente: se a imagem e o texto não mostram, deixe a parte de fora.`,
      userPrompt: `A 1ª imagem é a primeira tela (390×844); a 2ª é a página inteira (cortada). Texto da página, pra conferir: """${pageText}"""

Partes da página:
${areasForPrompt({ pageType: opts.pageType, pageOnly: true })}

Responda:
{
  "notes": "uma frase com o que esta página faz de diferente",
  "by_area": { "<parte>": "uma frase concreta com o que a página faz nessa parte (ex.: '4 produtos na primeira tela, filtro fixo no topo')" }
}
Em by_area, só as partes que aparecem nas imagens ou no texto.`,
      contentParts: [
        { type: "image", url: await opts.mediaUrl(screenshotUrl) },
        { type: "image", url: await opts.mediaUrl(fullUrl) },
      ],
    },
    opts.onUsage,
  );
  const json = extractJsonObject(raw);
  let notes = "";
  let byArea: Partial<Record<UxArea, string>> = {};
  if (json) {
    try {
      const p = JSON.parse(json) as Record<string, unknown>;
      notes = typeof p.notes === "string" ? p.notes : "";
      byArea = parseByArea(p.by_area, opts.pageType);
    } catch {
      // Invalid reading: the screenshot stays without anatomy.
    }
  }
  return {
    domain: opts.domain,
    page_type: opts.pageType,
    url,
    screenshot_url: screenshotUrl,
    full_url: fullUrl,
    anatomy: {
      sticky_buy: null,
      size_above_fold: null,
      price_above_fold: null,
      shipping_estimate: null,
      wishlist: null,
      recommendation_position: null,
      notes,
      by_area: byArea,
    },
    captured_at: opts.now,
  };
}

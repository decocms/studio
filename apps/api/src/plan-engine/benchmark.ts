/**
 * Benchmark: como as PDPs de outras lojas resolvem o que a nossa não resolve.
 *
 * O app olha sozinho: começa pela lista guardada no perfil e, se faltar loja
 * (lista vazia ou loja que não abre — muro anti-robô, sem PDP), o modelo sugere
 * outras até completar; o navegador acha uma PDP de cada uma a partir da home
 * e tira o print do celular (primeira tela e página inteira), e uma passada de
 * visão lê a anatomia (barra fixa? tamanho na dobra?) e o que a loja faz em
 * cada parte da página — é isso que a hipótese cita em "quem já faz". O
 * resultado fica 30 dias em cache — concorrente não muda de PDP toda hora.
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

/** Tarefa de leitura, não de julgamento. */
const BENCHMARK_MODEL: LlmTier = "smart";

/** How many stores the benchmark compares. */
export const MAX_COMPETITORS = 5;

/**
 * Quantas lojas pedir ao modelo. Mais que MAX_COMPETITORS porque parte não
 * abre: em 09/11 quatro de cinco sugestões voltaram sem PDP (muro anti-robô,
 * e um domínio parecido que vendia outra coisa).
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
 * Concorrentes sugeridos pelo modelo a partir da loja: mesmo segmento, PDP boa
 * no celular, e que um navegador automático consiga abrir — as gigantes
 * internacionais barram robô (sondado em 10/11), então o prompt puxa pras do
 * mesmo país. Cada item vem com marca e o que vende: obriga o modelo a se
 * comprometer com a loja certa em vez de chutar um domínio parecido.
 */
export async function suggestCompetitors(opts: {
  llm: Llm;
  domain: string;
  storeDescription: string;
  /** Lojas que já estão na lista ou já falharam nesta rodada. */
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
 * Título e descrição da home da loja — o que o modelo precisa pra sugerir
 * concorrentes do mesmo segmento sem a gente dizer qual é.
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

/** Concorrente abre sem o `?html=1`, que é só da loja analisada (forceHtml). */
function openCompetitor(
  browser: BrowserPort,
  url: string,
  onStatus?: (status: number) => void,
): Promise<BrowserPage> {
  return openPage(browser, url, "mobile", { ownStore: false, onStatus });
}

/**
 * Tempo do teto por loja guardado pros prints e a leitura da página achada:
 * a procura para antes, com uma lacuna que diz até onde chegou.
 */
const CAPTURE_RESERVE_MS = 40_000;
/** Vitrines da home abertas atrás de produto. */
const MAX_LISTINGS = 3;
/** Candidatas a PDP abertas até uma se confirmar. */
const MAX_PDP_TRIES = 4;

const hasTime = (deadline: number | undefined) =>
  deadline === undefined || Date.now() < deadline;

/** Sitemaps are read from where the browser runs, unless a test hands its own. */
const sitemapFetcher = (browser: BrowserPort, fetcher: Fetcher | undefined) =>
  fetcher ?? browserFetcher(browser, SITEMAP_FETCH);

/** Os links da página, classificados fora dela (store-discovery.ts). */
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
 * Abre uma URL que pode não existir (vitrine, candidata do sitemap, rota de
 * busca): a que não abriu é pulada; muro anti-robô e queda do navegador sobem.
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
 * Desafio anti-robô que recarrega sem parar derruba a leitura no meio com essa
 * frase do navegador, que na tela dos limites não diz nada a ninguém.
 */
function asBotWall(err: unknown, url: string): unknown {
  const msg = err instanceof Error ? err.message : String(err);
  return /Execution context was destroyed/i.test(msg)
    ? new BotWallError("página que não para de recarregar", url)
    : err;
}

/**
 * Candidatas a PDP a partir de uma home, da mais provável à menos, abrindo
 * vitrine só quando quem consome pede mais: links com padrão de PDP da home;
 * os das vitrines da home (menu antes de rodapé); o sitemap. "Talvez PDP"
 * (card com foto, `.html`) entra junto quando a página tem cara de grade de
 * produtos, senão no fim. Quem abre confirma pelos dados estruturados.
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

/** O que a captura de um concorrente usa de fora. */
interface CompetitorOpts {
  browser: BrowserPort;
  media: MediaStore;
  llm: Llm;
  /** Um link que o modelo consegue baixar, a partir do caminho na mídia. */
  mediaUrl: (path: string) => Promise<string>;
  domain: string;
  keyPrefix: string;
  now: string;
  /** O teto por loja: a procura para antes, guardando tempo pro print. */
  budgetMs: number;
  onUsage: (u: LlmUsage) => void;
  fetcher?: Fetcher;
}

/**
 * Abre a home do concorrente, segue as candidatas a PDP até uma que se declare
 * Product (JSON-LD, microdata ou og:type), tira o print do celular e lê a
 * anatomia.
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
  /** Primeira tela e página inteira, nessa ordem. */
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

// ── Benchmark de home, categoria e busca ─────────────────────────────────────

type Found = { page: BrowserPage; url: string };

/** A primeira das URLs que lista produto; as outras são fechadas. */
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
 * Uma vitrine do concorrente: as da home (menu antes de rodapé) e, sem
 * nenhuma que liste produto, as categorias do sitemap.
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

/** Rotas de busca testadas por loja: a do formulário, a da plataforma, as comuns. */
const MAX_SEARCH_ROUTES = 5;

/**
 * A busca do concorrente: a rota do formulário da home, a da plataforma
 * reconhecida e as comuns, nessa ordem, até uma listar produto. A primeira
 * rota que responde (mesmo com "nenhum resultado") é a busca da loja; se o
 * termo da loja analisada não acha nada ali, tenta uma vez com um termo do
 * menu do concorrente, que pode nem vender aquilo. Rota que não abre não
 * encerra as outras; muro anti-robô encerra a loja.
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
 * A página do concorrente do mesmo tipo da nossa: a home, uma vitrine que
 * lista produto, ou a busca. Print do celular e leitura do que ela faz em cada
 * parte (as áreas daquele tipo de página).
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

/** Print e leitura da página achada. */
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
      // Leitura inválida: fica o print sem anatomia.
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

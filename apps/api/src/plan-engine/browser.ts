/**
 * O navegador pra ver a loja como a cliente vê: abrir a PDP no tamanho de um
 * celular, medir onde estão preço, tamanho e botão, ler o design system e
 * tirar o print. O navegador em si é uma porta (BrowserPort); no Studio ele
 * roda num sandbox.
 *
 * Tudo que roda DENTRO da página (as funções passadas a `page.evaluate`) mora em
 * page-scripts.ts, separado de propósito: aquelas funções são serializadas e
 * executadas no Chrome, então não podem fechar sobre nada deste módulo.
 */

import { sleep } from "@decocms/shared/std";
import {
  dismissOverlaysInPage,
  scrollPageToInPage,
  wallSnapshotInPage,
} from "./page-scripts.ts";
import {
  type BrowserPage,
  type BrowserPort,
  BrowserSessionError,
  type MediaStore,
  type Viewport,
} from "./ports.ts";
import type { UxDevice } from "./types.ts";

/** Viewports dos relatórios: iPhone comum e notebook comum. */
export const VIEWPORTS: Record<
  UxDevice,
  Viewport & { isMobile: boolean; hasTouch: boolean }
> = {
  mobile: {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  desktop: {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
};

/**
 * User-agent de celular de verdade. Sem ele muita loja serve o layout de desktop
 * espremido, e o print "do celular" mente.
 */
export const USER_AGENTS: Record<UxDevice, string> = {
  mobile:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  desktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

const NAVIGATION_TIMEOUT_MS = 45_000;

/** The waits that let a page react (lazy-load, anti-bot reload); tests swap it. */
let pause: (ms: number) => Promise<void> = sleep;

/** Test hook: replaces the page waits; returns the restore. */
export function __setPageWaitForTesting(
  fn: (ms: number) => Promise<void>,
): () => void {
  const previous = pause;
  pause = fn;
  return () => {
    pause = previous;
  };
}

/**
 * Teto do print de página inteira, em px CSS. A PDP de uma loja de moda passa
 * de 10.000px no celular; a 2x isso vira uma imagem de 20.000px que nenhum
 * modelo de visão lê e que a tela nem mostra. O que importa está nas primeiras
 * telas.
 */
export const FULL_PAGE_MAX_HEIGHT = 6_000;

/**
 * Roda `fn` com um navegador que fecha, no fim, toda página que `fn` abriu,
 * mesmo com erro ou com `fn` ainda pendurada (o teto por loja do benchmark).
 * Depois de fechado, abrir página nele falha.
 */
export async function withBrowser<T>(
  browser: BrowserPort,
  fn: (browser: BrowserPort) => Promise<T>,
): Promise<T> {
  const open = new Set<BrowserPage>();
  let closed = false;
  const scoped: BrowserPort = {
    async newPage(device, opts) {
      if (closed) throw new BrowserSessionError("a sessão do navegador fechou");
      const page = await browser.newPage(device, opts);
      if (closed) {
        await page.close().catch(() => {});
        throw new BrowserSessionError("a sessão do navegador fechou");
      }
      open.add(page);
      return {
        get viewport() {
          return page.viewport;
        },
        url: () => page.url(),
        goto: (url, timeoutMs) => page.goto(url, timeoutMs),
        reload: (timeoutMs) => page.reload(timeoutMs),
        evaluate: (fn, ...args) => page.evaluate(fn, ...args),
        screenshot: (o) => page.screenshot(o),
        mouseMove: (x, y, steps) => page.mouseMove(x, y, steps),
        click: (x, y, settleMs) => page.click(x, y, settleMs),
        blockedRequests: () => page.blockedRequests(),
        close: async () => {
          open.delete(page);
          await page.close();
        },
      };
    },
    fetch: (url, opts) => browser.fetch(url, opts),
  };
  try {
    return await fn(scoped);
  } finally {
    closed = true;
    await Promise.all([...open].map((p) => p.close().catch(() => {})));
    open.clear();
  }
}

/**
 * Abre `url` no dispositivo pedido e deixa a página pronta pra medir: espera a
 * rede acalmar, fecha banner de cookie/newsletter e rola até o fim e de volta
 * pra disparar o lazy-load (sem isso a recomendação nem existe no DOM).
 *
 * `blockRequest` aborta os pedidos que casarem (o verificador corta rastreio,
 * pra um teste nosso não virar clique de cliente no heatmap); a página conta
 * quantos abortou. `keepOverlays` deixa pop-up e banner abertos: é o teste do
 * verificador sobre o próprio pop-up. `ownStore: false` abre sem o `?html=1`
 * (concorrente: ver `forceHtml`). `onStatus` recebe o status HTTP da última
 * navegação.
 */
export async function openPage(
  browser: BrowserPort,
  url: string,
  device: UxDevice,
  opts: {
    blockRequest?: (url: string) => boolean;
    keepOverlays?: boolean;
    ownStore?: boolean;
    onStatus?: (status: number) => void;
  } = {},
): Promise<BrowserPage> {
  const { blockRequest, keepOverlays = false, ownStore = true } = opts;
  const page = await browser.newPage(device, { blockRequest });
  try {
    let status = 0;
    let lastTarget = url;
    let gotoError: string | null = null;
    const go = async (target: string) => {
      lastTarget = target;
      const res = await page.goto(target, NAVIGATION_TIMEOUT_MS);
      gotoError = res.error;
      if (res.error === null) {
        status = res.status ?? 0;
      } else {
        // Rede que nunca acalma (tag de terceiro): o DOM carregado já serve pra medir.
        console.warn(
          `[plan-engine] a rede não acalmou em ${target}, seguindo com o DOM: ${res.error}`,
        );
      }
    };
    await go(ownStore ? forceHtml(url) : url);
    // Um redirect (apex → www) pode derrubar o `?html=1`: pede de novo a partir da URL final.
    const landed = ownStore ? htmlRetryUrl(page.url()) : null;
    if (landed) await go(landed);
    opts.onStatus?.(status);
    const contentType = await page
      .evaluate(() => document.contentType)
      .catch(() => "");
    const failure = navigationFailure(page.url(), lastTarget, gotoError);
    if (failure) throw new PageOpenError(failure);
    if (!/html/i.test(contentType)) {
      throw new PageOpenError(
        `a loja serviu ${contentType || "algo que não é HTML"} pro navegador em ${page.url()} (versão pra agente?)`,
      );
    }
    // O desafio anti-robô recarrega sozinho: lê de novo depois de uma espera.
    const snapshot = async () => {
      try {
        return classifyBotWall({
          status,
          ...(await page.evaluate(wallSnapshotInPage)),
        });
      } catch (err) {
        if (err instanceof BrowserSessionError) throw err;
        return "desafio que recarrega a página";
      }
    };
    let wall = await snapshot();
    if (wall) {
      await pause(WALL_RETRY_WAIT_MS);
      wall = await snapshot();
    }
    if (wall) throw new BotWallError(wall, page.url());
    if (!keepOverlays) await page.evaluate(dismissOverlaysInPage);
    await scrollThrough(page, VIEWPORTS[device].height);
    if (!keepOverlays) await page.evaluate(dismissOverlaysInPage);
    return page;
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

/**
 * A página não abriu (DNS, conexão) ou não veio em HTML. No benchmark, numa
 * vitrine ou rota de busca, é só aquela URL: tenta a próxima.
 */
export class PageOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageOpenError";
  }
}

/** Quanto esperar um desafio anti-robô que recarrega sozinho (o do Akamai leva ~5s). */
const WALL_RETRY_WAIT_MS = 7_000;

/** A loja respondeu um muro anti-robô em vez da página. */
export class BotWallError extends Error {
  constructor(
    readonly wall: string,
    readonly url: string,
  ) {
    // Sem a URL: a do desafio carrega um token de 200 caracteres.
    super(`bloqueou o navegador automático (anti-robô: ${wall})`);
    this.name = "BotWallError";
  }
}

/**
 * Muro por status HTTP (401/403/429), o mesmo critério do `blocks_bots` do
 * domain-check: a loja barra robô e ninguém aqui conserta isso.
 */
export function isStatusBotWall(err: unknown): boolean {
  return err instanceof BotWallError && /^HTTP (401|403|429)$/.test(err.wall);
}

/**
 * A página é um muro anti-robô? Devolve o nome dele ou null. Sondado em 10/11
 * em lojas grandes de moda: Akamai `bm-verify`, DataDome, Cloudflare "Just a
 * moment", Akamai "Access Denied", 429.
 *
 * Só vale página quase vazia: loja de verdade carrega o script do DataDome ou
 * do Turnstile mesmo quando deixa passar, e isso não é muro.
 */
export function classifyBotWall(snap: {
  status: number;
  links: number;
  html: string;
  text: string;
}): string | null {
  if (snap.links >= 8) return null;
  const { html, text } = snap;
  if (/captcha-delivery\.com/i.test(html)) return "DataDome";
  if (/px-captcha/i.test(html)) return "PerimeterX";
  if (/cf-chl-|<title>\s*Just a moment/i.test(html)) return "Cloudflare";
  if (
    /bm-verify=|triggerInterstitialChallenge|\/interstitial\/ic\.html/i.test(
      html,
    )
  )
    return "Akamai";
  if (/Access Denied/i.test(text) && /Reference\s*#|edgesuite/i.test(html))
    return "Akamai";
  if (/_Incapsula_Resource/i.test(html)) return "Imperva";
  if (
    /verify you are (a )?human|are you a robot|press (&|and) hold/i.test(text)
  )
    return "desafio";
  if (snap.status === 401 || snap.status === 403 || snap.status === 429)
    return `HTTP ${snap.status}`;
  return null;
}

/**
 * Loja que serve versão pra agente responde markdown em vez da PDP: uma loja
 * de moda devolveu um texto com "type: product", e preço/tamanho/botão
 * voltaram todos `null`.
 *
 * `?html=1` é a saída de debug dessas lojas: sempre HTML. Só vale pra loja
 * analisada: no concorrente é um parâmetro desconhecido, que a plataforma dele
 * pode ler como filtro de busca ou de vitrine, ou servir como outra página. O
 * benchmark abre com `ownStore: false`. Loja que bloqueia agente sem saída
 * nenhuma vai aparecer como captura vazia — o print mostra o porquê.
 */
export function forceHtml(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("html", "1");
    return u.href;
  } catch {
    return url;
  }
}

/**
 * Motivo de a página nunca ter aberto (DNS, host fora do ar, conexão
 * recusada); NULL quando a URL final é http(s), mesmo com erro na navegação.
 * O Chrome cai em `chrome-error://` e o `document.contentType` dali não é
 * HTML, o que sem isto virava "versão pra agente". Rede que não acalma numa
 * página real não conta.
 */
export function navigationFailure(
  finalUrl: string,
  target: string,
  gotoError: string | null,
): string | null {
  const message = gotoError ?? "";
  const code = message.match(/net::ERR_[A-Z_]+/)?.[0];
  if (/^https?:\/\//i.test(finalUrl)) return null;
  return `não abriu ${target}: ${code ?? (message || "página de erro do navegador")}`;
}

/**
 * A URL pra pedir de novo quando a navegação perdeu o `?html=1` num redirect;
 * NULL quando ele sobreviveu. Tira o `.md` da rota de agente (`/p.md` → `/p`).
 */
export function htmlRetryUrl(finalUrl: string): string | null {
  try {
    const u = new URL(finalUrl);
    if (u.searchParams.has("html")) return null;
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.pathname = u.pathname.replace(/\.md$/, "");
    return forceHtml(u.href);
  } catch {
    return null;
  }
}

/**
 * Rola a página até `y` (px do documento) e devolve a rolagem que ficou de
 * fato. Único caminho de rolagem do lado de fora: `window.scrollTo` sozinho
 * não mexia em loja com scroll-behavior smooth e o <body> como rolador.
 */
async function scrollPageTo(page: BrowserPage, y: number): Promise<number> {
  return await page.evaluate(scrollPageToInPage, y);
}

/**
 * Rola em passos até o fim e volta ao topo — dispara o lazy-load. Para quando
 * a rolagem efetiva não anda mais (fim da página), com teto de 20.000px.
 */
async function scrollThrough(
  page: BrowserPage,
  screenHeight: number,
): Promise<void> {
  const step = Math.max(400, Math.floor(screenHeight * 0.8));
  let last = -1;
  for (let y = 0; y < 20_000; y += step) {
    const at = await scrollPageTo(page, y);
    await pause(120);
    if (typeof at !== "number" || at <= last) break;
    last = at;
  }
  await scrollPageTo(page, 0);
  await pause(400);
}

/** Grava a imagem na mídia da org e devolve o caminho que `MediaStore.url` lê. */
export async function storeImage(
  media: MediaStore,
  path: string,
  bytes: Uint8Array,
  contentType = "image/jpeg",
): Promise<string> {
  return await media.put(path, bytes, contentType);
}

/** Print da primeira tela (o que a cliente vê sem rolar). */
export async function screenshotFold(page: BrowserPage): Promise<Uint8Array> {
  await scrollPageTo(page, 0);
  return await page.screenshot({ quality: 72 });
}

/** Print da página inteira, cortado em FULL_PAGE_MAX_HEIGHT. */
export async function screenshotFull(page: BrowserPage): Promise<Uint8Array> {
  const height = await page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
  );
  const { width, deviceScaleFactor } = page.viewport;
  const clipHeight = Math.min(height, FULL_PAGE_MAX_HEIGHT);
  return await page.screenshot({
    quality: 60,
    clip: {
      x: 0,
      y: 0,
      width,
      height: clipHeight,
      scale: fullPageScale(clipHeight, deviceScaleFactor),
    },
    captureBeyondViewport: true,
  });
}

/**
 * Teto de lado da imagem que o modelo de visão aceita: 8.000px (o provedor
 * recusa o pedido inteiro com 400 acima disso). Fica uma folga.
 */
export const MAX_IMAGE_SIDE_PX = 7_800;

/**
 * Escala do print de página inteira pra caber no teto do modelo. O celular é
 * capturado a 2x: 6.000px CSS viram 12.000px de imagem — foi o 400 de 05/11,
 * quando a PDP passou a abrir em HTML.
 */
export function fullPageScale(
  cssHeight: number,
  deviceScaleFactor: number,
): number {
  const px = cssHeight * deviceScaleFactor;
  return px > MAX_IMAGE_SIDE_PX ? MAX_IMAGE_SIDE_PX / px : 1;
}

/** Print de um recorte da página (px CSS, coordenadas do documento). */
export async function screenshotClip(
  page: BrowserPage,
  clip: { x: number; y: number; width: number; height: number },
): Promise<Uint8Array> {
  return await page.screenshot({
    quality: 80,
    clip,
    captureBeyondViewport: true,
  });
}

/** What a browser fetch looks like to code written against `fetch`. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * `fetch` through the browser's host, for the pure modules that take one
 * (sitemap, domain check). Reads at most `maxBytes` of the body.
 */
export function browserFetcher(
  browser: BrowserPort,
  opts: { maxBytes: number; timeoutMs: number },
): Fetcher {
  return async (url, init) => {
    const userAgent =
      new Headers(init?.headers).get("user-agent") ?? USER_AGENTS.desktop;
    const res = await browser.fetch(url, { ...opts, userAgent });
    const nullBody = [101, 103, 204, 205, 304].includes(res.status);
    const response = new Response(nullBody ? null : res.body, {
      status: res.status,
    });
    Object.defineProperty(response, "url", { value: res.url });
    return response;
  };
}

/**
 * Opens the store as a shopper sees it, on a `BrowserPort` (a sandbox in Studio).
 * Code that runs inside the page lives in page-scripts.ts: it is serialized to
 * Chrome, so it cannot close over anything in this module.
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

/** Report viewports: a common phone and a common laptop. */
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

/** A real phone user agent; without it many stores serve a squeezed desktop layout. */
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

/** Full-page screenshot cap in CSS px: what matters is in the first screens. */
export const FULL_PAGE_MAX_HEIGHT = 6_000;

/**
 * Runs `fn` with a browser that closes every page `fn` opened when it ends, even
 * on error or while `fn` still hangs. Opening a page after that fails.
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
 * Opens `url` on `device` ready to measure: network settled, overlays dismissed
 * (unless `keepOverlays`), scrolled through for lazy-load. `ownStore: false`
 * skips `?html=1`; `blockRequest` aborts matching requests.
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
        // A network that never settles still leaves a DOM good enough to measure.
        console.warn(
          `[plan-engine] a rede não acalmou em ${target}, seguindo com o DOM: ${res.error}`,
        );
      }
    };
    await go(ownStore ? forceHtml(url) : url);
    // A redirect can drop `?html=1`: request again from the final URL.
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
    // Anti-bot challenges reload on their own: read again after a wait.
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

/** The page did not open (DNS, connection) or was not HTML; callers may try the next URL. */
export class PageOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageOpenError";
  }
}

/** How long to wait for a self-reloading anti-bot challenge. */
const WALL_RETRY_WAIT_MS = 7_000;

/** The store answered with an anti-bot wall instead of the page. */
export class BotWallError extends Error {
  constructor(
    readonly wall: string,
    readonly url: string,
  ) {
    // No URL in the message: the challenge's URL carries a long token.
    super(`bloqueou o navegador automático (anti-robô: ${wall})`);
    this.name = "BotWallError";
  }
}

/** A wall by HTTP status (401/403/429), as domain-check's `blocks_bots`. */
export function isStatusBotWall(err: unknown): boolean {
  return err instanceof BotWallError && /^HTTP (401|403|429)$/.test(err.wall);
}

/**
 * The anti-bot wall's name, or null. Only near-empty pages count: real stores
 * load wall scripts even when they let the browser through.
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
 * Adds `?html=1`, which forces HTML on stores that serve markdown to agents.
 * Only for the analyzed store: elsewhere it is an unknown parameter.
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
 * Why the page never opened (DNS, host down, refused); null when the final URL
 * is http(s), even if navigation reported an error.
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
 * The URL to request again when a redirect dropped `?html=1`; null when it
 * survived. Strips an agent route's `.md`.
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

/** Scrolls to `y` (document px) and returns the scroll actually reached. */
async function scrollPageTo(page: BrowserPage, y: number): Promise<number> {
  return await page.evaluate(scrollPageToInPage, y);
}

/** Scrolls to the end in steps and back to the top, to trigger lazy-load. */
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

/** Stores the image in the org's media; returns the path `MediaStore.url` reads. */
export async function storeImage(
  media: MediaStore,
  path: string,
  bytes: Uint8Array,
  contentType = "image/jpeg",
): Promise<string> {
  return await media.put(path, bytes, contentType);
}

/** Screenshot of the first screen, before any scroll. */
export async function screenshotFold(page: BrowserPage): Promise<Uint8Array> {
  await scrollPageTo(page, 0);
  return await page.screenshot({ quality: 72 });
}

/** Full-page screenshot, cut at FULL_PAGE_MAX_HEIGHT. */
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

/** Largest image side the vision model accepts, with some margin. */
export const MAX_IMAGE_SIDE_PX = 7_800;

/** Scale that fits a full-page screenshot within the model's image cap. */
export function fullPageScale(
  cssHeight: number,
  deviceScaleFactor: number,
): number {
  const px = cssHeight * deviceScaleFactor;
  return px > MAX_IMAGE_SIDE_PX ? MAX_IMAGE_SIDE_PX / px : 1;
}

/** Screenshot of a page region (CSS px, document coordinates). */
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

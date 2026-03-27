/**
 * Browser shared utilities
 *
 * Single source of truth for browser connection (remote Browserless OR local Playwright),
 * device emulation, URL validation, and browser session lifecycle.
 *
 * Dual-mode:
 * - Remote: BROWSERLESS_TOKEN set → connects to Browserless via WebSocket
 * - Local: PLAYWRIGHT_CHROMIUM_PATH set → launches local Chromium
 * - Neither: tools throw with setup instructions
 */

import puppeteer from "puppeteer-core";
import type { Page } from "puppeteer-core";
import { z } from "zod";
import { existsSync } from "node:fs";

// ============================================================================
// Constants
// ============================================================================

const BROWSERLESS_ENDPOINT =
  process.env.BROWSERLESS_ENDPOINT ?? "wss://production-sfo.browserless.io";

export const MOBILE_VIEWPORT = {
  width: 375,
  height: 812,
  isMobile: true,
} as const;

export const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;

export const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** Max navigation timeout (60 seconds) */
export const MAX_TIMEOUT_MS = 60_000;

// ============================================================================
// Zod fragments — shared across tools
// ============================================================================

/** IPv4 patterns that resolve to private/internal networks — block SSRF. */
const PRIVATE_IPV4 =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+)$/i;

/** Check if a hostname targets a private/internal network (SSRF protection).
 * Handles plain IPv4, IPv6 loopback, unique-local (fc/fd), link-local (fe80),
 * and IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) by extracting the embedded
 * IPv4 and checking it against PRIVATE_IPV4. */
function isPrivateHost(hostname: string): boolean {
  // Strip brackets for IPv6
  const h = hostname.replace(/^\[|\]$/g, "");

  // Plain IPv4 or localhost
  if (PRIVATE_IPV4.test(h)) return true;

  // IPv6 loopback
  if (h === "::1") return true;

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/i.test(h) || /^fe[89ab][0-9a-f]:/i.test(h))
    return true;

  // IPv4-mapped IPv6 (::ffff:x.x.x.x) — Node normalizes to hex form [::ffff:HHHH:HHHH]
  // Extract the embedded IPv4 and check it against private ranges.
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    const ip = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return PRIVATE_IPV4.test(ip);
  }
  // Also handle dotted form ::ffff:127.0.0.1
  const mappedDot = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedDot) {
    return PRIVATE_IPV4.test(mappedDot[1]!);
  }

  return false;
}

/** URL input validated for http/https only + no private IPs */
export const urlInput = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "Only http/https URLs allowed")
  .refine((u) => {
    try {
      const host = new URL(u).hostname;
      return !isPrivateHost(host);
    } catch {
      return false;
    }
  }, "URLs targeting private/internal networks are not allowed");

/** Device emulation input */
export const deviceInput = z
  .enum(["desktop", "mobile"])
  .default("desktop")
  .describe("Device emulation");

/** Residential proxy country code — ISO 3166-1 alpha-2 */
export const proxyCountryInput = z
  .string()
  .regex(/^[a-z]{2}$/i, "Must be a 2-letter ISO country code (e.g. 'us', 'br')")
  .transform((v) => v.toLowerCase())
  .optional()
  .describe("Residential proxy country code (e.g. 'us', 'br')");

// ============================================================================
// Mode detection — remote (Browserless) vs local (Playwright Chromium)
// ============================================================================

/** Well-known Playwright Chromium install locations */
const CHROMIUM_SEARCH_PATHS = [
  // macOS Playwright
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
  // Linux Playwright
  `${process.env.HOME}/.cache/ms-playwright/chromium-*/chrome-linux/chrome`,
  // Explicit env override
  process.env.PLAYWRIGHT_CHROMIUM_PATH,
].filter(Boolean) as string[];

let _cachedChromiumPath: string | null | undefined;

/** Find a local Chromium binary installed by Playwright */
export function findLocalChromium(): string | null {
  if (_cachedChromiumPath !== undefined) return _cachedChromiumPath;

  // Explicit env path takes priority
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    if (existsSync(process.env.PLAYWRIGHT_CHROMIUM_PATH)) {
      _cachedChromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
      return _cachedChromiumPath;
    }
  }

  // Search well-known Playwright cache dirs using glob
  try {
    const { globSync } = require("node:fs");
    for (const pattern of CHROMIUM_SEARCH_PATHS) {
      if (!pattern.includes("*")) continue;
      const matches = globSync(pattern);
      if (matches.length > 0) {
        const found = matches.sort().pop() ?? null;
        _cachedChromiumPath = found;
        return found;
      }
    }
  } catch {
    // globSync not available in older Node, try manual check
  }

  _cachedChromiumPath = null;
  return null;
}

/** Check which browser mode is available */
export function getBrowserMode(): "remote" | "local" | "none" {
  if (process.env.BROWSERLESS_TOKEN) return "remote";
  if (findLocalChromium()) return "local";
  return "none";
}

// ============================================================================
// Token + endpoint (remote mode)
// ============================================================================

export function getBrowserlessToken(): string {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) {
    throw new Error(
      "BROWSERLESS_TOKEN environment variable is not set. Add it to your .env file.",
    );
  }
  return token;
}

/** Get the HTTP base URL for Browserless REST APIs (derived from WS endpoint) */
export function getHttpBaseUrl(): string {
  return BROWSERLESS_ENDPOINT.replace(/^wss?:\/\//, "https://");
}

// ============================================================================
// Browser session lifecycle — works in both modes
// ============================================================================

/** Extract a human-readable message from any error shape */
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (obj.error instanceof Error) return obj.error.message;
    if (typeof obj.error === "string") return obj.error;
    try {
      return JSON.stringify(err);
    } catch {
      // fall through
    }
  }
  return `Browser error (${typeof err})`;
}

/**
 * Open a browser page and run a function.
 *
 * Automatically picks the right mode:
 * - Remote: connects to Browserless via WebSocket (when endpoint provided)
 * - Local: launches local Chromium (when no endpoint, but local Chromium found)
 *
 * @param endpoint - Browserless WS endpoint. Pass null/undefined to use local mode.
 */
export async function withBrowserPage<T>(
  endpoint: string | null | undefined,
  device: "desktop" | "mobile",
  fn: (page: Page) => Promise<T>,
  options?: {
    cookies?: Record<string, string>;
    domain?: string;
  },
): Promise<T> {
  let browser;
  try {
    if (endpoint) {
      // Remote mode — connect to Browserless
      const connectPromise = puppeteer.connect({
        browserWSEndpoint: endpoint,
        protocolTimeout: MAX_TIMEOUT_MS,
      });
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Browserless connection timed out after 15s")),
          15_000,
        );
      });
      try {
        browser = await Promise.race([connectPromise, timeoutPromise]);
      } catch (error) {
        connectPromise
          .then((lateBrowser) => lateBrowser.close().catch(() => {}))
          .catch(() => {});
        throw error;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    } else {
      // Local mode — launch local Chromium
      const chromiumPath = findLocalChromium();
      if (!chromiumPath) {
        throw new Error(
          "No browser available. Set BROWSERLESS_TOKEN for remote, or install Playwright Chromium locally: npx playwright install chromium",
        );
      }
      browser = await puppeteer.launch({
        executablePath: chromiumPath,
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });
    }

    const page = await browser.newPage();

    if (device === "mobile") {
      await page.setViewport(MOBILE_VIEWPORT);
      await page.setUserAgent(MOBILE_UA);
    } else {
      await page.setViewport(DESKTOP_VIEWPORT);
    }

    // Set cookies before navigation
    if (options?.cookies && options.domain) {
      const cookieEntries = Object.entries(options.cookies).map(
        ([name, value]) => ({
          name,
          value,
          domain: options.domain!,
          path: "/",
        }),
      );
      await page.setCookie(...cookieEntries);
    }

    return await fn(page);
  } catch (err) {
    const message = extractErrorMessage(err);
    throw new Error(message.replace(/token=[^&\s]+/gi, "token=<redacted>"));
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Get a browser endpoint for the current mode.
 * Returns the Browserless WS endpoint (remote) or null (local).
 * Throws if no browser is available.
 */
export function resolveBrowserEndpoint(proxyCountry?: string): string | null {
  const mode = getBrowserMode();
  if (mode === "remote") {
    const token = getBrowserlessToken();
    const params = new URLSearchParams({ token });
    if (proxyCountry) {
      params.set("proxy", "residential");
      params.set("proxyCountry", proxyCountry);
    }
    return `${BROWSERLESS_ENDPOINT}?${params}`;
  }
  if (mode === "local") {
    return null; // withBrowserPage will use local launch
  }
  throw new Error(
    "No browser available. Set BROWSERLESS_TOKEN for remote, or install Playwright Chromium: npx playwright install chromium",
  );
}

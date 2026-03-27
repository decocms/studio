/**
 * Capture HAR Built-in Tool
 *
 * Navigates to a URL via Browserless (puppeteer-core over WebSocket)
 * and captures network data across multiple passes in a single session.
 *
 * One tool call = one URL fully diagnosed:
 *   Desktop: 3 loads (1 cold + 2 warm cache)
 *   Mobile:  3 loads (1 cold + 2 warm cache)
 *
 * Same browser session throughout, so warm passes use real browser cache.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import puppeteer from "puppeteer-core";
import type { Page } from "puppeteer-core";
import { harFromMessages } from "chrome-har";
import {
  urlInput,
  proxyCountryInput,
  MAX_TIMEOUT_MS,
  MOBILE_VIEWPORT,
  DESKTOP_VIEWPORT,
  MOBILE_UA,
  resolveBrowserEndpoint,
} from "./browserless";

// Concurrency limiter — max 2 simultaneous Browserless sessions to avoid
// starving the account and causing timeouts when the LLM fires many in parallel.
const MAX_CONCURRENT = 2;
let activeSessions = 0;
const waitQueue: (() => void)[] = [];

async function acquireSession(): Promise<void> {
  if (activeSessions < MAX_CONCURRENT) {
    activeSessions++;
    return;
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve));
  activeSessions++;
}

function releaseSession(): void {
  activeSessions--;
  const next = waitQueue.shift();
  if (next) next();
}

const CDP_OBSERVE = [
  "Page.loadEventFired",
  "Page.domContentEventFired",
  "Page.frameStartedLoading",
  "Page.frameAttached",
  "Network.requestWillBeSent",
  "Network.requestServedFromCache",
  "Network.dataReceived",
  "Network.responseReceived",
  "Network.resourceChangedPriority",
  "Network.loadingFinished",
  "Network.loadingFailed",
] as const;

export const InputSchema = z.object({
  url: urlInput.describe("The URL to diagnose"),
  waitUntil: z
    .enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
    .default("networkidle2")
    .describe("When to consider navigation complete"),
  timeout: z
    .number()
    .max(MAX_TIMEOUT_MS)
    .default(30000)
    .describe("Navigation timeout in milliseconds"),
  passes: z
    .number()
    .min(1)
    .max(5)
    .default(2)
    .describe(
      "Number of loads per device (1=cold only, 2=cold+1 warm, 3=cold+2 warm)",
    ),
  proxyCountry: proxyCountryInput,
  cookies: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Cookies to set on every request as key-value pairs, e.g. { '_deco_bucket': 'worker' }",
    ),
});

// ============================================================================
// HAR analysis helpers
// ============================================================================

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname;
    return path.length > 80 ? `${path.slice(0, 77)}...` : path;
  } catch {
    return url.slice(0, 80);
  }
}

function buildHeaderMap(
  headers?: Array<{ name: string; value: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!headers || !Array.isArray(headers)) return map;
  for (const h of headers) {
    if (h?.name && h?.value) {
      map.set(h.name.toLowerCase(), h.value);
    }
  }
  return map;
}

interface PassResult {
  device: "desktop" | "mobile";
  pass: number;
  label: string;
  ttfbMs: number | null;
  totalRequests: number;
  totalKB: number;
  cache: { hits: number; misses: number };
  failedCount: number;
}

interface FullAnalysis {
  byType: Record<string, { count: number; bytes: number }>;
  failed: { path: string; status: number }[];
  top10Slowest: { path: string; ms: number; status: number; kb: number }[];
  topThirdParty: { domain: string; requests: number; kb: number }[];
  cacheDetails: {
    path: string;
    cacheControl: string;
    xCache: string;
    age: string;
  }[];
}

function analyzeHarEntries(
  entries: Array<{
    request?: { url?: string };
    response?: {
      status?: number;
      content?: { size?: number; mimeType?: string };
      headers?: Array<{ name: string; value: string }>;
    };
    timings?: { wait?: number };
    time?: number;
    startedDateTime?: string;
  }>,
  pageHost: string,
  collectDetails: boolean,
): {
  pass: Omit<PassResult, "device" | "pass" | "label">;
  details?: FullAnalysis;
} {
  let totalBytes = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let failedCount = 0;
  let ttfbMs: number | null = null;
  const byType: Record<string, { count: number; bytes: number }> = {};
  const failed: { path: string; status: number }[] = [];
  const thirdParty: Record<string, { count: number; bytes: number }> = {};
  const cacheDetails: FullAnalysis["cacheDetails"] = [];
  const top10Slowest: FullAnalysis["top10Slowest"] = [];
  let minSlowMs = 0;

  for (const entry of entries) {
    const size = entry.response?.content?.size ?? 0;
    totalBytes += size;

    const mime = entry.response?.content?.mimeType ?? "unknown";
    const type = mime.startsWith("image/")
      ? "image"
      : mime.includes("javascript")
        ? "script"
        : mime.includes("css")
          ? "stylesheet"
          : mime.includes("html")
            ? "document"
            : mime.includes("font")
              ? "font"
              : mime.includes("json")
                ? "json"
                : "other";

    if (!byType[type]) byType[type] = { count: 0, bytes: 0 };
    byType[type].count++;
    byType[type].bytes += size;

    const headers = buildHeaderMap(entry.response?.headers);
    const xCache = headers.get("x-cache") ?? "";
    const age = headers.get("age") ?? "";
    const cacheControl = headers.get("cache-control") ?? "";
    const cfCacheStatus = headers.get("cf-cache-status") ?? "";

    const isHit =
      xCache.toLowerCase().includes("hit") ||
      cfCacheStatus.toLowerCase() === "hit";
    const isMiss =
      xCache.toLowerCase().includes("miss") ||
      cfCacheStatus.toLowerCase() === "miss";

    if (isHit) {
      cacheHits++;
    } else if (isMiss || (cacheControl && cacheControl.includes("no-store"))) {
      cacheMisses++;
    } else if (cacheControl) {
      cacheMisses++;
    }

    if (
      collectDetails &&
      (type === "document" || type === "script" || type === "stylesheet") &&
      cacheDetails.length < 30
    ) {
      cacheDetails.push({
        path: shortUrl(entry.request?.url ?? ""),
        cacheControl: cacheControl || "none",
        xCache: xCache || cfCacheStatus || "none",
        age: age || "-",
      });
    }

    const status = entry.response?.status ?? 0;
    if (!entry.response || status >= 400 || status === 0) {
      failedCount++;
      if (collectDetails && failed.length < 20) {
        failed.push({ path: shortUrl(entry.request?.url ?? ""), status });
      }
    }

    if (
      ttfbMs === null &&
      type === "document" &&
      entry.timings?.wait &&
      entry.timings.wait > 0
    ) {
      ttfbMs = Math.round(entry.timings.wait);
    }

    if (collectDetails) {
      try {
        const reqHost = new URL(entry.request?.url ?? "").hostname;
        if (reqHost !== pageHost && !reqHost.endsWith(`.${pageHost}`)) {
          if (!thirdParty[reqHost])
            thirdParty[reqHost] = { count: 0, bytes: 0 };
          thirdParty[reqHost].count++;
          thirdParty[reqHost].bytes += size;
        }
      } catch {
        // skip malformed URLs
      }

      const ms = Math.round(entry.time ?? 0);
      if (top10Slowest.length < 10 || ms > minSlowMs) {
        const item = {
          path: shortUrl(entry.request?.url ?? ""),
          ms,
          status,
          kb: Math.round(size / 1024),
        };
        if (top10Slowest.length < 10) {
          top10Slowest.push(item);
          if (top10Slowest.length === 10) {
            top10Slowest.sort((a, b) => b.ms - a.ms);
            minSlowMs = top10Slowest[9]!.ms;
          }
        } else {
          top10Slowest[9] = item;
          top10Slowest.sort((a, b) => b.ms - a.ms);
          minSlowMs = top10Slowest[9]!.ms;
        }
      }
    }
  }

  if (collectDetails && top10Slowest.length > 0) {
    top10Slowest.sort((a, b) => b.ms - a.ms);
  }

  const passResult = {
    ttfbMs,
    totalRequests: entries.length,
    totalKB: Math.round(totalBytes / 1024),
    cache: { hits: cacheHits, misses: cacheMisses },
    failedCount,
  };

  if (!collectDetails) return { pass: passResult };

  const topThirdParty = Object.entries(thirdParty)
    .sort(([, a], [, b]) => b.bytes - a.bytes)
    .slice(0, 15)
    .map(([domain, stats]) => ({
      domain,
      requests: stats.count,
      kb: Math.round(stats.bytes / 1024),
    }));

  return {
    pass: passResult,
    details: {
      byType,
      failed: failed.slice(0, 10),
      top10Slowest: top10Slowest.slice(0, 10),
      topThirdParty,
      cacheDetails: cacheDetails.slice(0, 20),
    },
  };
}

// ============================================================================
// Single-pass capture: open CDP, navigate, collect events, parse HAR
// ============================================================================

async function capturePass(
  page: Page,
  url: string,
  waitUntil: "load" | "domcontentloaded" | "networkidle0" | "networkidle2",
  timeout: number,
): Promise<{ method: string; params: unknown }[]> {
  const events: { method: string; params: unknown }[] = [];

  const client = await page.createCDPSession();
  await client.send("Page.enable");
  await client.send("Network.enable");

  for (const method of CDP_OBSERVE) {
    client.on(method, (params) => {
      events.push({ method, params });
    });
  }

  await page.goto(url, { waitUntil, timeout });

  if (waitUntil !== "networkidle0") {
    await new Promise((r) => setTimeout(r, 500));
  }

  await client.detach();
  return events;
}

// ============================================================================
// Tool definition
// ============================================================================

export function createCaptureHarTool() {
  return tool({
    description:
      "Diagnose a URL with multiple passes in a single browser session. " +
      "Runs N passes on desktop then N on mobile (default 3 each = 6 total). " +
      "Pass 1 is cold cache, passes 2+ are warm (real browser cache). " +
      "Returns per-pass metrics (TTFB, requests, cache ratio) plus detailed " +
      "analysis from the cold desktop pass (slowest requests, third-party, etc).",
    inputSchema: zodSchema(InputSchema),
    execute: async (input: z.infer<typeof InputSchema>) => {
      // Acquire a session slot — blocks if MAX_CONCURRENT sessions are active
      await acquireSession();
      try {
        return await executeCapture(input);
      } finally {
        releaseSession();
      }
    },
  });
}

async function executeCapture(
  input: z.infer<typeof InputSchema>,
): Promise<string> {
  const endpoint = resolveBrowserEndpoint(input.proxyCountry);
  const pageHost = new URL(input.url).hostname;

  const passResults: PassResult[] = [];
  let details: FullAnalysis | undefined;

  let browser;
  try {
    if (endpoint) {
      browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
    } else {
      // Local mode — launch local Chromium
      const { findLocalChromium } = await import("./browserless");
      const chromiumPath = findLocalChromium();
      if (!chromiumPath) {
        throw new Error(
          "No browser available. Set BROWSERLESS_TOKEN or install Playwright: npx playwright install chromium",
        );
      }
      browser = await puppeteer.launch({
        executablePath: chromiumPath,
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      });
    }
    const page = await browser.newPage();

    // Set cookies if provided
    if (input.cookies) {
      const cookieEntries = Object.entries(input.cookies).map(
        ([name, value]) => ({
          name,
          value,
          domain: pageHost,
          path: "/",
        }),
      );
      await page.setCookie(...cookieEntries);
    }

    // --- Desktop passes ---
    await page.setViewport(DESKTOP_VIEWPORT);

    for (let i = 0; i < input.passes; i++) {
      const isFirst = i === 0;
      const label = isFirst ? "cold" : `warm-${i}`;

      const events = await capturePass(
        page,
        input.url,
        input.waitUntil,
        input.timeout,
      );

      let har;
      try {
        har = harFromMessages(events, {
          includeTextFromResponseBody: false,
        });
      } catch {
        passResults.push({
          device: "desktop",
          pass: i + 1,
          label,
          ttfbMs: null,
          totalRequests: 0,
          totalKB: 0,
          cache: { hits: 0, misses: 0 },
          failedCount: 0,
        });
        continue;
      }

      const entries = har?.log?.entries ?? [];
      // Collect full details only on the first desktop pass (cold)
      const analysis = analyzeHarEntries(entries, pageHost, isFirst);

      passResults.push({
        device: "desktop",
        pass: i + 1,
        label,
        ...analysis.pass,
      });

      if (isFirst && analysis.details) {
        details = analysis.details;
      }
    }

    // --- Mobile passes ---
    await page.setViewport(MOBILE_VIEWPORT);
    await page.setUserAgent(MOBILE_UA);

    // Clear cache before mobile cold pass so it's a real cold start
    const cdp = await page.createCDPSession();
    await cdp.send("Network.clearBrowserCache");
    await cdp.detach();

    for (let i = 0; i < input.passes; i++) {
      const label = i === 0 ? "cold" : `warm-${i}`;

      const events = await capturePass(
        page,
        input.url,
        input.waitUntil,
        input.timeout,
      );

      let har;
      try {
        har = harFromMessages(events, {
          includeTextFromResponseBody: false,
        });
      } catch {
        passResults.push({
          device: "mobile",
          pass: i + 1,
          label,
          ttfbMs: null,
          totalRequests: 0,
          totalKB: 0,
          cache: { hits: 0, misses: 0 },
          failedCount: 0,
        });
        continue;
      }

      const entries = har?.log?.entries ?? [];
      const analysis = analyzeHarEntries(entries, pageHost, false);

      passResults.push({
        device: "mobile",
        pass: i + 1,
        label,
        ...analysis.pass,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({
      url: input.url,
      error: message.replace(/token=[^&\s]+/gi, "token=<redacted>"),
      passResults,
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  return JSON.stringify({
    url: input.url,
    passes: passResults,
    ...(details ?? {}),
  });
}

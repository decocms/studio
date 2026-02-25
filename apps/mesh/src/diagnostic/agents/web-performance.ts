/**
 * Web Performance Diagnostic Agent
 *
 * Fetches Core Web Vitals and performance scores from PageSpeed Insights API,
 * performs image audit and HTML size analysis, and extracts cache headers.
 * Standalone async function — no MeshContext dependency.
 */

import type { CrawlResult } from "../crawl";

export type VitalRating = "good" | "needs-improvement" | "poor" | "unknown";

export interface CoreWebVital {
  value: number;
  rating: VitalRating;
}

export interface StrategyScores {
  performanceScore?: number;
  lcp?: CoreWebVital;
  inp?: CoreWebVital;
  cls?: CoreWebVital;
}

export interface CruxMetric {
  category: string;
  percentiles?: {
    p75: number;
  };
}

export interface CruxData {
  overallCategory?: string;
  lcp?: CruxMetric;
  inp?: CruxMetric;
  cls?: CruxMetric;
  fid?: CruxMetric;
}

export interface ImageIssue {
  type: string;
  severity: "critical" | "warning" | "info";
  message: string;
  count?: number;
}

export interface ImageAuditResult {
  totalImages: number;
  lazyLoadedImages: number;
  hasFetchPriorityHigh: boolean;
  excessivePreloads: boolean;
  preloadCount: number;
  usesAvif: boolean;
  usesWebP: boolean;
  hasSrcset: boolean;
  hasSizes: boolean;
  issues: ImageIssue[];
}

export interface HtmlSizeResult {
  totalBytes: number;
  frameworkPayloadBytes: number;
  structuredDataBytes: number;
}

export interface WebPerformanceResult {
  mobile?: StrategyScores;
  desktop?: StrategyScores;
  cruxData?: CruxData;
  imageAudit: ImageAuditResult;
  htmlSize: HtmlSizeResult;
  cacheHeaders: Record<string, string>;
}

const PSI_API_BASE =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const PSI_TIMEOUT_MS = 60_000;

// Web Vitals thresholds from web.dev
const THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 }, // ms
  inp: { good: 200, poor: 500 }, // ms
  cls: { good: 0.1, poor: 0.25 }, // unitless
} as const;

function rateVital(
  value: number,
  metric: keyof typeof THRESHOLDS,
): VitalRating {
  const thresholds = THRESHOLDS[metric];
  if (value <= thresholds.good) return "good";
  if (value <= thresholds.poor) return "needs-improvement";
  return "poor";
}

/**
 * Call the PageSpeed Insights API for a given strategy.
 * Returns null on failure (network error, rate limit, etc.).
 */
async function fetchPsiData(
  url: string,
  strategy: "mobile" | "desktop",
  apiKey?: string,
): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams({
    url,
    strategy,
    category: "performance",
  });
  if (apiKey) {
    params.set("key", apiKey);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PSI_TIMEOUT_MS);

  try {
    const response = await fetch(`${PSI_API_BASE}?${params}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      console.warn(
        `[diagnostic:web-performance] PSI API returned ${response.status} for ${strategy}`,
      );
      return null;
    }

    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    const err = error as Error;
    if (err.name === "AbortError") {
      console.warn(
        `[diagnostic:web-performance] PSI API timeout for ${strategy} (${PSI_TIMEOUT_MS}ms)`,
      );
    } else {
      console.warn(
        `[diagnostic:web-performance] PSI API error for ${strategy}: ${err.message}`,
      );
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parse strategy scores from PSI API response.
 */
function parsePsiScores(data: Record<string, unknown>): StrategyScores {
  const lighthouse = data["lighthouseResult"] as
    | Record<string, unknown>
    | undefined;
  if (!lighthouse) return {};

  const categories = lighthouse["categories"] as
    | Record<string, Record<string, unknown>>
    | undefined;
  const audits = lighthouse["audits"] as
    | Record<string, Record<string, unknown>>
    | undefined;

  const performanceScore =
    typeof categories?.["performance"]?.["score"] === "number"
      ? Math.round((categories["performance"]["score"] as number) * 100)
      : undefined;

  const lcpMs =
    typeof audits?.["largest-contentful-paint"]?.["numericValue"] === "number"
      ? (audits["largest-contentful-paint"]["numericValue"] as number)
      : undefined;

  const clsValue =
    typeof audits?.["cumulative-layout-shift"]?.["numericValue"] === "number"
      ? (audits["cumulative-layout-shift"]["numericValue"] as number)
      : undefined;

  const inpMs =
    typeof audits?.["interaction-to-next-paint"]?.["numericValue"] === "number"
      ? (audits["interaction-to-next-paint"]["numericValue"] as number)
      : undefined;

  return {
    performanceScore,
    lcp:
      lcpMs !== undefined
        ? { value: lcpMs, rating: rateVital(lcpMs, "lcp") }
        : undefined,
    cls:
      clsValue !== undefined
        ? { value: clsValue, rating: rateVital(clsValue, "cls") }
        : undefined,
    inp:
      inpMs !== undefined
        ? { value: inpMs, rating: rateVital(inpMs, "inp") }
        : undefined,
  };
}

/**
 * Extract CrUX field data from PSI response.
 * The PSI API embeds CrUX data in loadingExperience.
 */
function parseCruxData(data: Record<string, unknown>): CruxData | undefined {
  const loadingExp = data["loadingExperience"] as
    | Record<string, unknown>
    | undefined;
  if (!loadingExp) return undefined;

  const overallCategory =
    typeof loadingExp["overall_category"] === "string"
      ? (loadingExp["overall_category"] as string)
      : undefined;

  // No CrUX data available for this URL (low traffic site)
  if (!overallCategory) return undefined;

  const metrics = loadingExp["metrics"] as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!metrics) return { overallCategory };

  const parseMetric = (key: string): CruxMetric | undefined => {
    const m = metrics[key];
    if (!m) return undefined;
    const category =
      typeof m["category"] === "string" ? m["category"] : "UNKNOWN";
    const percentiles = m["percentiles"] as Record<string, number> | undefined;
    return {
      category,
      percentiles:
        percentiles?.["p75"] !== undefined
          ? { p75: percentiles["p75"] }
          : undefined,
    };
  };

  return {
    overallCategory,
    lcp: parseMetric("LARGEST_CONTENTFUL_PAINT_MS"),
    inp: parseMetric("INTERACTION_TO_NEXT_PAINT"),
    cls: parseMetric("CUMULATIVE_LAYOUT_SHIFT_SCORE"),
    fid: parseMetric("FIRST_INPUT_DELAY_MS"),
  };
}

/**
 * Audit images in HTML for performance best practices.
 */
function auditImages(html: string): ImageAuditResult {
  const issues: ImageIssue[] = [];

  // Count total img tags
  const imgTags = html.match(/<img\s[^>]*>/gi) ?? [];
  const totalImages = imgTags.length;

  // Count lazy-loaded images
  const lazyLoadedImages = imgTags.filter((tag) =>
    /loading\s*=\s*["']lazy["']/i.test(tag),
  ).length;

  // Check for fetchpriority="high" (LCP optimization)
  const hasFetchPriorityHigh =
    /<img\s[^>]*fetchpriority\s*=\s*["']high["'][^>]*>/i.test(html);

  // Check preload tags
  const preloadTags =
    html.match(
      /<link\s[^>]*rel\s*=\s*["']preload["'][^>]*as\s*=\s*["']image["'][^>]*>/gi,
    ) ?? [];
  const preloadCount = preloadTags.length;
  const excessivePreloads = preloadCount > 3;

  // Check image formats
  const allImgSrcContent = imgTags.join(" ");
  const usesAvif =
    /\.avif/i.test(allImgSrcContent) ||
    /type\s*=\s*["']image\/avif["']/i.test(html);
  const usesWebP =
    /\.webp/i.test(allImgSrcContent) ||
    /type\s*=\s*["']image\/webp["']/i.test(html);

  // Check responsive images
  const hasSrcset = /\bsrcset\s*=/i.test(html);
  const hasSizes = /\bsizes\s*=/i.test(html);

  // Build issues list
  if (totalImages > 0 && lazyLoadedImages === 0) {
    issues.push({
      type: "missing-lazy-load",
      severity: "warning",
      message: `${totalImages} images found but none use loading="lazy"`,
      count: totalImages,
    });
  }

  if (totalImages > 0 && !hasFetchPriorityHigh) {
    issues.push({
      type: "missing-fetchpriority",
      severity: "info",
      message:
        'No image uses fetchpriority="high" — consider setting it on the LCP image',
    });
  }

  if (excessivePreloads) {
    issues.push({
      type: "excessive-preloads",
      severity: "warning",
      message: `${preloadCount} image preload tags found — too many preloads can hurt performance`,
      count: preloadCount,
    });
  }

  if (totalImages > 0 && !usesWebP && !usesAvif) {
    issues.push({
      type: "no-modern-formats",
      severity: "warning",
      message:
        "No WebP or AVIF images detected — modern formats reduce file sizes significantly",
    });
  }

  if (totalImages > 3 && !hasSrcset) {
    issues.push({
      type: "missing-responsive-images",
      severity: "info",
      message:
        "No srcset attributes found — responsive images improve mobile performance",
    });
  }

  return {
    totalImages,
    lazyLoadedImages,
    hasFetchPriorityHigh,
    excessivePreloads,
    preloadCount,
    usesAvif,
    usesWebP,
    hasSrcset,
    hasSizes,
    issues,
  };
}

/**
 * Analyze HTML size and framework payload bloat.
 */
function analyzeHtmlSize(html: string): HtmlSizeResult {
  const totalBytes = new TextEncoder().encode(html).length;

  // Check framework JSON payload blobs
  let frameworkPayloadBytes = 0;

  // Next.js __NEXT_DATA__
  const nextDataMatch = html.match(
    /<script\s+id\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (nextDataMatch?.[1]) {
    frameworkPayloadBytes += new TextEncoder().encode(nextDataMatch[1]).length;
  }

  // Deco/Fresh __FRSH_STATE
  const frshMatch = html.match(
    /<script\s+id\s*=\s*["']__FRSH_STATE["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (frshMatch?.[1]) {
    frameworkPayloadBytes += new TextEncoder().encode(frshMatch[1]).length;
  }

  // Calculate total structured data size
  let structuredDataBytes = 0;
  const jsonLdPattern =
    /<script\s+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch: RegExpExecArray | null;
  while ((jsonLdMatch = jsonLdPattern.exec(html)) !== null) {
    if (jsonLdMatch[1]) {
      structuredDataBytes += new TextEncoder().encode(jsonLdMatch[1]).length;
    }
  }

  return {
    totalBytes,
    frameworkPayloadBytes,
    structuredDataBytes,
  };
}

/**
 * Extract cache-related HTTP response headers.
 */
function extractCacheHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const cacheHeaderKeys = [
    "cache-control",
    "etag",
    "last-modified",
    "x-cache",
    "age",
    "expires",
    "pragma",
    "vary",
    "cdn-cache-control",
    "surrogate-control",
  ];

  const result: Record<string, string> = {};
  for (const key of cacheHeaderKeys) {
    if (headers[key]) {
      result[key] = headers[key];
    }
  }
  return result;
}

/**
 * Run the web performance diagnostic agent.
 * Calls PSI API for mobile and desktop, performs image audit and HTML analysis.
 */
export async function runWebPerformanceAgent(
  url: string,
  crawl: CrawlResult,
): Promise<WebPerformanceResult> {
  const apiKey = process.env["PAGESPEED_API_KEY"];

  // Run PSI API calls in parallel for mobile and desktop
  const [mobileData, desktopData] = await Promise.all([
    fetchPsiData(url, "mobile", apiKey),
    fetchPsiData(url, "desktop", apiKey),
  ]);

  const mobile = mobileData ? parsePsiScores(mobileData) : undefined;
  const desktop = desktopData ? parsePsiScores(desktopData) : undefined;

  // Extract CrUX data from mobile PSI response (mobile has more CrUX coverage)
  const cruxData = mobileData
    ? parseCruxData(mobileData)
    : desktopData
      ? parseCruxData(desktopData)
      : undefined;

  // Audit images in the crawled HTML
  const imageAudit = auditImages(crawl.html);

  // Analyze HTML size
  const htmlSize = analyzeHtmlSize(crawl.html);

  // Extract cache headers
  const cacheHeaders = extractCacheHeaders(crawl.headers);

  return {
    mobile,
    desktop,
    cruxData,
    imageAudit,
    htmlSize,
    cacheHeaders,
  };
}

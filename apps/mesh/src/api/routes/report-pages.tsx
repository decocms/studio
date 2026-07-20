/**
 * Server-rendered shell for the report page (`/report/:domain`).
 *
 * Link unfurlers (Slack, Discord, iMessage, WhatsApp, Twitter/X, Facebook,
 * LinkedIn) do not run the SPA, so production serves the built index.html with
 * per-report metadata: a domain-derived title/description enriched with the
 * report's real score + verdict, the brand's own favicon, a canonical URL, and
 * an OG/Twitter share image. The authenticated SPA still fetches the full deck
 * after the session gate — this shell only carries what a crawler reads.
 *
 * The share IMAGE is the brand's homepage screenshot, served from the reports
 * engine's edge worker (a stable, public, absolute URL). We LINK it; we never
 * render it here. The original in-process Satori + Resvg renderer did CPU-heavy
 * synchronous work inside Studio's Bun process, blocking the event loop shared
 * by health checks and authenticated APIs — do NOT restore in-process image
 * rendering here. When no screenshot exists yet (an unscanned domain), we fall
 * back to a designed static card (`/report-og-fallback.png`).
 */

import { Hono } from "hono";
import { join } from "node:path";
import {
  brandFromDomain,
  faviconForDomain,
  normalizeDomain,
  reportShareCopy,
} from "@/shared/report-seo";
import { toDeck, type PublicReportResponse } from "@/reports/to-deck";
import { resolveBaseUrl } from "@/tools/reports/auth-client";
import { getSettings } from "@/settings";

/** Give the engine a short budget — the shell must render fast for crawlers,
 *  and a slow/dead engine must degrade to domain-only copy, never hang. */
const ENGINE_TIMEOUT_MS = 2500;

/**
 * A screenshot is only safe as an OG image if unfurlers can re-fetch it later:
 * crawlers cache the URL and re-request it long after we serve the page. The
 * engine returns two kinds — stable, clean-path worker URLs (good) and
 * short-lived, SIGNED object-storage URLs (`?Expires=…&Signature=…`, which 403
 * once expired, leaving a broken card). Accept only https URLs with no query
 * string; anything signed carries query params and falls back to the static
 * card. Errs toward the designed fallback, never a broken image.
 */
export function isShareSafeImageUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.search === "";
  } catch {
    return false;
  }
}

/** The per-report facts a crawler card needs, distilled from the public deck. */
export interface ReportSeo {
  brand: string;
  score?: number;
  verdict?: string;
  /** Absolute, externally-hosted homepage screenshot URL. */
  screenshot?: string;
}

/**
 * Read the public (no-auth) diagnostics for a domain and distill the share
 * facts. Fail-soft: any error/timeout/miss returns null so the caller falls
 * back to domain-only copy.
 */
async function fetchReportSeo(domain: string): Promise<ReportSeo | null> {
  try {
    const res = await fetch(
      `${resolveBaseUrl({})}/api/v2/public/diagnostics/${encodeURIComponent(
        domain,
      )}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const resp = (await res.json()) as PublicReportResponse;
    const { deck } = toDeck(resp);
    if (!deck.slides.length) return null;

    const cover = deck.slides.find((s) => s.template.template === "cover");
    // Narrow the discriminated union so a template rename is a compile error,
    // not a silent `undefined` (no `as`-cast onto the union).
    const tpl = cover?.template;
    const coverTpl = tpl && tpl.template === "cover" ? tpl : undefined;

    return {
      brand: deck.meta.brand?.trim() || brandFromDomain(domain),
      score: deck.meta.scores?.cover ?? coverTpl?.score?.value,
      verdict:
        cover?.annotation?.trim() || cover?.headline?.trim() || undefined,
      screenshot: coverTpl?.screenshot?.trim() || undefined,
    };
  } catch {
    return null;
  }
}

/** Escape a string for safe interpolation into an HTML attribute/text node. */
function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function buildReportHead(
  rawDomain: string,
  seo: ReportSeo | null,
): string {
  const domain = normalizeDomain(rawDomain);
  const brand = seo?.brand?.trim() || brandFromDomain(domain);
  const favicon = faviconForDomain(domain, 128);
  const origin = (
    getSettings().baseUrl ?? "https://studio.decocms.com"
  ).replace(/\/+$/, "");
  const canonical = `${origin}/report/${encodeURIComponent(domain)}`;

  const { title, description } = reportShareCopy({
    brand,
    domain,
    score: seo?.score,
    verdict: seo?.verdict,
  });

  // Both branches are large landscape images ⇒ summary_large_image. Use the
  // per-report homepage screenshot only when it is share-safe (a stable,
  // re-fetchable URL — never a signed/expiring one); otherwise the designed
  // static card. og:image MUST be absolute for every unfurler.
  const usingScreenshot = isShareSafeImageUrl(seo?.screenshot);
  const image = usingScreenshot
    ? (seo?.screenshot as string)
    : `${origin}/report-og-fallback.png`;
  const imageAlt = `${brand} commerce report by decocms`;

  const tags = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<meta name="robots" content="noindex, follow" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="decocms" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(canonical)}" />`,
    `<meta property="og:image" content="${esc(image)}" />`,
    `<meta property="og:image:alt" content="${esc(imageAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${esc(image)}" />`,
    `<meta name="twitter:image:alt" content="${esc(imageAlt)}" />`,
    `<link rel="canonical" href="${esc(canonical)}" />`,
    `<link rel="icon" href="${esc(favicon)}" sizes="any" />`,
  ];
  // Only claim dimensions for the fallback, whose size we control (1200×630).
  // Lying about the screenshot's dimensions crops it badly on LinkedIn/WhatsApp.
  if (!usingScreenshot) {
    tags.push(
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
    );
  }
  return tags.join("\n    ");
}

/** Replace only metadata tags; Vite-injected script/style tags stay intact. */
function rewriteHead(html: string, headBlock: string): string {
  const stripped = html
    .replace(/<title>[\s\S]*?<\/title>\s*/i, "")
    .replace(/<meta\s+name="(?:description|twitter:[^"]*)"[^>]*>\s*/gi, "")
    .replace(/<meta\s+property="og:[^"]*"[^>]*>\s*/gi, "")
    .replace(/<link\s+rel="icon"[^>]*>\s*/gi, "");
  return stripped.replace("</head>", `    ${headBlock}\n  </head>`);
}

export function createReportPagesRoutes(clientDir: string | undefined): Hono {
  const app = new Hono();

  app.get("/:domain", async (c) => {
    const raw = c.req.param("domain");
    const indexPath = clientDir ? join(clientDir, "index.html") : null;
    const indexFile = indexPath ? Bun.file(indexPath) : null;
    if (!indexFile || !(await indexFile.exists())) {
      // Dev (Vite fronts the SPA) or missing client build — nothing to rewrite.
      return c.notFound();
    }

    const html = await indexFile.text();
    try {
      const seo = await fetchReportSeo(normalizeDomain(raw));
      const head = buildReportHead(raw, seo);
      return c.html(rewriteHead(html, head), 200, {
        "Cache-Control": "public, max-age=0, s-maxage=300",
      });
    } catch {
      // Never 500 the page — the plain SPA shell still boots and recovers.
      return c.html(html);
    }
  });

  return app;
}

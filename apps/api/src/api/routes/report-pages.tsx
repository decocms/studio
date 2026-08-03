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
 * The share IMAGE is the full cover card (favicon · url · score ring · device
 * frames with the real captured screenshots), rendered by the reports worker
 * (satori/resvg on the edge — see decocms/reports) and PROXIED by the sibling
 * `GET /report/:domain/og.png` route so og:image stays same-origin. The worker
 * always answers 200 with a branded card (even for an unscanned domain); the
 * designed static card remains the fallback for a dead/slow worker only.
 */

import { Hono } from "hono";
import { join } from "node:path";
import {
  brandFromDomain,
  faviconForDomain,
  normalizeDomain,
  reportShareCopy,
} from "@decocms/shared/report-seo";
import {
  toDeck,
  type PublicReportResponse,
} from "@decocms/shared/reports/to-deck";
import { resolveBaseUrl } from "@/tools/reports/auth-client";
import { getSettings } from "@/settings";

/** Give the engine a short budget — the shell must render fast for crawlers,
 *  and a slow/dead engine must degrade to domain-only copy, never hang. */
const ENGINE_TIMEOUT_MS = 2500;

/** The per-report facts a crawler card needs, distilled from the public deck. */
export interface ReportSeo {
  brand: string;
  score?: number;
  verdict?: string;
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

  // The rendered per-report card (favicon + domain + score), or its static
  // fallback for an unscanned domain — both 1200×630, so summary_large_image.
  // og:image MUST be absolute for every unfurler.
  const image = `${canonical}/og.png`;
  const imageAlt = `${brand} commerce report by decocms`;

  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<meta name="robots" content="noindex, follow" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="decocms" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(canonical)}" />`,
    `<meta property="og:image" content="${esc(image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(imageAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${esc(image)}" />`,
    `<meta name="twitter:image:alt" content="${esc(imageAlt)}" />`,
    `<link rel="canonical" href="${esc(canonical)}" />`,
    `<link rel="icon" href="${esc(favicon)}" sizes="any" />`,
  ].join("\n    ");
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

/** The card render fetches + inlines screenshots before rasterizing — give it
 *  a real budget (unlike the HTML shell's 2.5s); the CDN caches the result, so
 *  a cold render is rare. */
const OG_PROXY_TIMEOUT_MS = 10_000;

export function createReportPagesRoutes(clientDir: string | undefined): Hono {
  const app = new Hono();

  // GET /report/:domain/og.png — the per-report share card, proxied from the
  // reports worker (GET /api/v2/public/diagnostics/:domain/og.png). The worker
  // renders the full cover card and always answers 200 (branded fallback for an
  // unscanned domain), so the designed static card here only covers a dead/slow
  // worker or a non-image reply. Registered before `/:domain` so the
  // two-segment path wins.
  app.get("/:domain/og.png", async (c) => {
    const domain = normalizeDomain(c.req.param("domain"));
    const serveFallback = async () => {
      const file = clientDir
        ? Bun.file(join(clientDir, "report-og-fallback.png"))
        : null;
      if (!file || !(await file.exists())) return c.notFound();
      return c.body(new Uint8Array(await file.arrayBuffer()), 200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=0, s-maxage=3600",
      });
    };
    try {
      const res = await fetch(
        `${resolveBaseUrl({})}/api/v2/public/diagnostics/${encodeURIComponent(
          domain,
        )}/og.png`,
        { signal: AbortSignal.timeout(OG_PROXY_TIMEOUT_MS) },
      );
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.startsWith("image/") || !res.body) {
        return serveFallback();
      }
      // Pipe the worker's stream through — never buffer the PNG here.
      return c.body(res.body, 200, {
        "Content-Type": type,
        // Crawlers cache the bytes; a day is plenty and re-scans are rare.
        "Cache-Control": "public, max-age=0, s-maxage=86400",
      });
    } catch {
      return serveFallback();
    }
  });

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

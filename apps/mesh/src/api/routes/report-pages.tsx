/**
 * Server-rendered shell for the auth-gated report page (`/report/:domain`).
 *
 * Link unfurlers do not run the SPA, so production serves the built index.html
 * with domain-derived title, description, canonical URL, and favicon. Report
 * data is deliberately absent from this anonymous shell; the authenticated SPA
 * fetches it after the session gate.
 *
 * Intentionally no dynamic `og:image`: the original Satori + Resvg renderer
 * performed CPU-heavy synchronous work inside Studio's Bun process, blocking
 * the event loop shared by health checks and authenticated APIs. Implement the
 * social card in an isolated edge service (for example a Cloudflare Worker),
 * then add that service's stable image URL in `buildReportHead`. Do not restore
 * in-process image rendering here.
 */

import { Hono } from "hono";
import { join } from "node:path";
import {
  brandFromDomain,
  faviconForDomain,
  normalizeDomain,
  reportShareCopy,
} from "@/shared/report-seo";
import { getSettings } from "@/settings";

/** Escape a string for safe interpolation into an HTML attribute/text node. */
function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildReportHead(rawDomain: string): string {
  const domain = normalizeDomain(rawDomain);
  const brand = brandFromDomain(domain);
  const favicon = faviconForDomain(domain, 128);
  const origin = (
    getSettings().baseUrl ?? "https://studio.decocms.com"
  ).replace(/\/+$/, "");
  const canonical = `${origin}/report/${encodeURIComponent(domain)}`;

  const { title, description } = reportShareCopy({
    brand,
    domain,
  });

  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<meta name="robots" content="noindex, follow" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="decocms" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(canonical)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
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
      const head = buildReportHead(raw);
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

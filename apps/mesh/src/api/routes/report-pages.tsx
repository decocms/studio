/**
 * Server-rendered surface of the public report page (`/report/:domain`):
 *
 * - `GET /report/:domain` — serves the SPA's index.html with the <head>
 *   rewritten for this domain (title/description/og/twitter/canonical), so
 *   link unfurlers (Slack/WhatsApp/X/iMessage) — which never run the SPA —
 *   see real metadata. Browsers get the same HTML and boot the SPA normally.
 * - `GET /report/:domain/og.png` — the 1200×630 share card, rendered with
 *   satori + resvg (ported from the landing's cf-workers-og version).
 *
 * Both paths are claimed away from the static asset handler via the
 * `/report/` prefix in `isServerPath` (api/utils/paths.ts) — without that,
 * a dotted path like /report/nike.com gets no SPA fallback for bots.
 */

import { Resvg } from "@resvg/resvg-js";
import { Hono } from "hono";
import { dirname, join } from "node:path";
import satori from "satori";
import {
  brandFromDomain,
  faviconForDomain,
  normalizeDomain,
  reportShareCopy,
} from "@/shared/report-seo";
import type { DeckSlide, TemplateDeck } from "@/reports/deck-types";
import { getSettings } from "@/settings";
import { fetchPublicReport } from "./public-reports";

const WIDTH = 1200;
const HEIGHT = 630;

// Lifted from the deck tokens so the card reads as one system with the report.
const INK = "#0d0906";
const MUTED = "#6b655f";
const BG = "#fbfaf7";
const BORDER = "#e5e3df";
const CHROME = "#f3f1ec";

function scoreTone(n: number): string {
  return n >= 70 ? "#009a41" : n >= 50 ? "#d98324" : "#ef4444";
}

// ── fonts ─────────────────────────────────────────────────────────────────────

async function loadFont(filename: string): Promise<ArrayBuffer> {
  const entryDir = dirname(process.argv[1] ?? import.meta.path);
  const candidates = [
    // Production bundle: copied beside server.js by bundle-server-script.ts.
    join(entryDir, "report-fonts", filename),
    // Source development: the entry point is apps/mesh/src/index.ts.
    join(entryDir, "reports/assets", filename),
    // Direct module execution (focused tests and scripts).
    join(import.meta.dir, "../../reports/assets", filename),
  ];
  for (const path of candidates) {
    const file = Bun.file(path);
    if (await file.exists()) return await file.arrayBuffer();
  }
  throw new Error(`Report font not found: ${filename}`);
}

let fontsPromise: Promise<
  {
    name: string;
    data: ArrayBuffer;
    weight: 400 | 500 | 700;
    style: "normal";
  }[]
> | null = null;

function getFonts() {
  fontsPromise ??= Promise.all([
    loadFont("roboto-regular.ttf").then((data) => ({
      name: "Roboto",
      data,
      weight: 400 as const,
      style: "normal" as const,
    })),
    loadFont("roboto-medium.ttf").then((data) => ({
      name: "Roboto",
      data,
      weight: 500 as const,
      style: "normal" as const,
    })),
    loadFont("roboto-bold.ttf").then((data) => ({
      name: "Roboto",
      data,
      weight: 700 as const,
      style: "normal" as const,
    })),
  ]);
  return fontsPromise;
}

// ── image inlining ───────────────────────────────────────────────────────────

/** Base64 a byte array in chunks — `btoa(String.fromCharCode(...huge))` blows
 *  the call stack on large screenshots, so we build the string in 32KB slices. */
function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * Fetch a remote image and inline it as a data URL, or return null on any
 * failure (network, non-2xx, or a format satori's rasterizer can't decode).
 * A null just degrades that slot to a placeholder — never fails the card.
 */
async function inlineImage(url: string | undefined): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      // Some CDNs (CloudFront/Firecrawl storage) 403 requests without browsery
      // headers; send a UA + Accept so server-side fetches aren't bounced.
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; decocms-og/1.0; +https://decocms.com)",
        Accept: "image/png,image/jpeg,image/*;q=0.8",
      },
    });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "image/png")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    // Satori decodes PNG/JPEG only — WebP/AVIF/SVG/ICO throw cryptically.
    if (type !== "image/png" && type !== "image/jpeg" && type !== "image/jpg") {
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    return bytesToDataUrl(bytes, type);
  } catch {
    return null;
  }
}

// ── report cover extraction ──────────────────────────────────────────────────

interface CoverData {
  score: number | null;
  desktopShot?: string;
  mobileShot?: string;
}

function coverFromDeck(deck: TemplateDeck | null): CoverData {
  const slide = deck?.slides.find(
    (s: DeckSlide) => s.template?.template === "cover",
  );
  const t = slide?.template as
    | {
        score?: { value?: number };
        screenshot?: string;
        mobileScreenshot?: string;
      }
    | undefined;
  return {
    score: typeof t?.score?.value === "number" ? t.score.value : null,
    desktopShot: t?.screenshot,
    mobileShot: t?.mobileScreenshot,
  };
}

// ── card sub-views ────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
  const tone = scoreTone(score);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        width: 132,
        height: 132,
        borderRadius: 132,
        border: `13px solid ${tone}`,
        backgroundColor: "#ffffff",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", color: tone }}>
        <span style={{ fontSize: 52, fontWeight: 700, lineHeight: 1 }}>
          {Math.round(score)}
        </span>
        <span style={{ fontSize: 22, fontWeight: 500, opacity: 0.7 }}>
          /100
        </span>
      </div>
    </div>
  );
}

function FaviconTile({
  src,
  initial,
}: {
  src: string | null;
  initial: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 76,
        height: 76,
        borderRadius: 16,
        backgroundColor: "#ffffff",
        border: `1px solid ${BORDER}`,
        boxShadow: "0 8px 28px rgba(13,9,6,0.10)",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      {src ? (
        <img
          src={src}
          width={52}
          height={52}
          style={{ objectFit: "contain" }}
        />
      ) : (
        <span style={{ fontSize: 38, fontWeight: 700, color: MUTED }}>
          {initial}
        </span>
      )}
    </div>
  );
}

/** A framed homepage preview. Placeholder (favicon) when no screenshot inlined. */
function DesktopFrame({
  domain,
  shot,
  favicon,
  initial,
}: {
  domain: string;
  shot: string | null;
  favicon: string | null;
  initial: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: 720,
        borderRadius: 20,
        backgroundColor: "#ffffff",
        border: `1px solid ${BORDER}`,
        // resvg traps on box-shadow with a large negative spread paired with a
        // large blur — keep blur ≤ ~50px and spread ≥ ~-20px.
        boxShadow:
          "0 2px 4px rgba(13,9,6,0.05), 0 26px 50px -18px rgba(13,9,6,0.32)",
        overflow: "hidden",
      }}
    >
      {/* browser chrome */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 48,
          padding: "0 20px",
          backgroundColor: CHROME,
          borderBottom: `1px solid ${BORDER}`,
        }}
      >
        <div style={{ display: "flex", gap: 8 }}>
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: 12,
              backgroundColor: "rgba(0,0,0,0.14)",
            }}
          />
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: 12,
              backgroundColor: "rgba(0,0,0,0.14)",
            }}
          />
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: 12,
              backgroundColor: "rgba(0,0,0,0.14)",
            }}
          />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginLeft: 16,
            height: 26,
            flexGrow: 1,
            borderRadius: 8,
            backgroundColor: "#ffffff",
            padding: "0 14px",
            fontSize: 15,
            color: MUTED,
          }}
        >
          {domain}
        </div>
      </div>
      {/* viewport */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 720,
          height: 344,
          backgroundColor: CHROME,
          overflow: "hidden",
        }}
      >
        {shot ? (
          <img
            src={shot}
            width={720}
            height={344}
            style={{ objectFit: "cover", objectPosition: "top" }}
          />
        ) : (
          <FaviconTile src={favicon} initial={initial} />
        )}
      </div>
    </div>
  );
}

function PhoneFrame({
  shot,
  favicon,
  initial,
}: {
  shot: string | null;
  favicon: string | null;
  initial: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: 168,
        borderRadius: 30,
        backgroundColor: "#ffffff",
        padding: 8,
        boxShadow:
          "0 2px 4px rgba(13,9,6,0.06), 0 26px 50px -20px rgba(13,9,6,0.4)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: 20,
        }}
      >
        <div
          style={{
            width: 44,
            height: 6,
            borderRadius: 6,
            backgroundColor: "rgba(0,0,0,0.14)",
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 152,
          height: 300,
          borderRadius: 22,
          backgroundColor: CHROME,
          overflow: "hidden",
        }}
      >
        {shot ? (
          <img
            src={shot}
            width={152}
            height={300}
            style={{ objectFit: "cover", objectPosition: "top" }}
          />
        ) : (
          <FaviconTile src={favicon} initial={initial} />
        )}
      </div>
    </div>
  );
}

// ── og image ──────────────────────────────────────────────────────────────────

async function buildOgImage(rawDomain: string): Promise<Response> {
  const domain = normalizeDomain(rawDomain);

  // Read the deck + inline every image concurrently. The report read may fail
  // (never scanned / API down) — fall back to domain-derived values.
  let deck: TemplateDeck | null = null;
  try {
    const state = await fetchPublicReport(rawDomain);
    deck = state.deck;
  } catch {
    deck = null;
  }

  const brand = deck?.meta.brand?.trim() || brandFromDomain(domain);
  const initial = (
    deck?.meta.initial ||
    brand.charAt(0) ||
    domain.charAt(0) ||
    "?"
  ).toUpperCase();
  const cover = coverFromDeck(deck);

  const [fonts, favicon, desktopShot, mobileShot] = await Promise.all([
    getFonts(),
    // Google's favicon service returns PNG (the deck faviconUrl is often .ico,
    // which satori can't decode), so always route the tile through it.
    inlineImage(faviconForDomain(domain, 128)),
    inlineImage(cover.desktopShot),
    inlineImage(cover.mobileShot),
  ]);

  const element = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: WIDTH,
        height: HEIGHT,
        backgroundColor: BG,
        color: INK,
        fontFamily: "Roboto",
        padding: "52px 60px",
      }}
    >
      {/* header row: favicon · url + eyebrow · score */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 22,
          paddingBottom: 28,
          borderBottom: `1px solid ${BORDER}`,
        }}
      >
        <FaviconTile src={favicon} initial={initial} />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: 20,
              letterSpacing: 2,
              textTransform: "uppercase",
              color: MUTED,
              fontWeight: 500,
            }}
          >
            Commerce report · decocms
          </span>
          <span
            style={{
              display: "flex",
              fontSize: 40,
              fontWeight: 700,
              marginTop: 4,
            }}
          >
            <span style={{ color: MUTED, fontWeight: 400 }}>https://</span>
            {domain}
          </span>
        </div>
        {cover.score !== null && <ScoreBadge score={cover.score} />}
      </div>

      {/* device cluster: desktop frame + overlapping phone */}
      <div
        style={{
          display: "flex",
          flexGrow: 1,
          alignItems: "center",
          justifyContent: "flex-end",
          position: "relative",
          paddingTop: 34,
        }}
      >
        <DesktopFrame
          domain={domain}
          shot={desktopShot}
          favicon={favicon}
          initial={initial}
        />
        <div
          style={{ display: "flex", position: "absolute", left: 8, bottom: 6 }}
        >
          <PhoneFrame shot={mobileShot} favicon={favicon} initial={initial} />
        </div>
      </div>
    </div>
  );

  const svg = await satori(element, { width: WIDTH, height: HEIGHT, fonts });
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
  })
    .render()
    .asPng();

  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      // Cache at the edge for a day (the underlying scan changes rarely); allow
      // a week of stale-while-revalidate so unfurl bots always get a warm image.
      "Cache-Control":
        "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
    },
  });
}

// ── head rewrite ──────────────────────────────────────────────────────────────

/** Escape a string for safe interpolation into an HTML attribute/text node. */
function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function buildReportHead(rawDomain: string): Promise<string> {
  const domain = normalizeDomain(rawDomain);

  // Best-effort deck read — a failure degrades to domain-derived copy.
  let deck: TemplateDeck | null = null;
  try {
    const state = await fetchPublicReport(rawDomain);
    deck = state.deck;
  } catch {
    deck = null;
  }

  const brand = deck?.meta.brand?.trim() || brandFromDomain(domain);
  const favicon = deck?.meta.faviconUrl || faviconForDomain(domain, 128);
  const origin = (
    getSettings().baseUrl ?? "https://studio.decocms.com"
  ).replace(/\/+$/, "");
  const canonical = `${origin}/report/${encodeURIComponent(domain)}`;
  const image = `${canonical}/og.png`;

  // The cover slide carries the overall score + the top verdict headline.
  const cover = deck?.slides.find((s) => s.template?.template === "cover");
  const coverBody = cover?.template as
    | { score?: { value?: number } }
    | undefined;
  const score =
    typeof coverBody?.score?.value === "number" ? coverBody.score.value : null;

  const { title, description } = reportShareCopy({
    brand,
    domain,
    score,
    verdict: cover?.headline ?? null,
  });

  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    // Reports stay out of the index; this metadata is for link unfurls
    // (Slack / WhatsApp / X / iMessage), not search ranking.
    `<meta name="robots" content="noindex, follow" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="decocms" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(canonical)}" />`,
    `<meta property="og:image" content="${esc(image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(`${brand} commerce report scorecard`)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${esc(image)}" />`,
    `<link rel="canonical" href="${esc(canonical)}" />`,
    `<link rel="icon" href="${esc(favicon)}" sizes="any" />`,
  ].join("\n    ");
}

/**
 * Replace index.html's static title/description/og/twitter head block with the
 * per-domain one. Removal is tag-targeted (title, description, Open Graph,
 * Twitter, and icon links) so Vite-injected script/style tags are untouched.
 */
function rewriteHead(html: string, headBlock: string): string {
  const stripped = html
    .replace(/<title>[\s\S]*?<\/title>\s*/i, "")
    .replace(/<meta\s+name="(?:description|twitter:[^"]*)"[^>]*>\s*/gi, "")
    .replace(/<meta\s+property="og:[^"]*"[^>]*>\s*/gi, "")
    .replace(/<link\s+rel="icon"[^>]*>\s*/gi, "");
  return stripped.replace("</head>", `    ${headBlock}\n  </head>`);
}

// ── routes ────────────────────────────────────────────────────────────────────

export function createReportPagesRoutes(clientDir: string | undefined): Hono {
  const app = new Hono();

  app.get("/:domain/og.png", async (c) => {
    const raw = c.req.param("domain");
    try {
      return await buildOgImage(raw);
    } catch {
      // A render failure must never break the unfurl — redirect to the
      // domain's favicon so the share still shows *something* recognizable.
      return c.redirect(faviconForDomain(normalizeDomain(raw), 256), 302);
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
      const head = await buildReportHead(raw);
      return c.html(rewriteHead(html, head), 200, {
        // Short shared cache: unfurl bots hit this in bursts per share; the
        // deck itself changes rarely.
        "Cache-Control": "public, max-age=0, s-maxage=300",
      });
    } catch {
      // Never 500 the page — the plain SPA shell still boots and recovers.
      return c.html(html);
    }
  });

  return app;
}

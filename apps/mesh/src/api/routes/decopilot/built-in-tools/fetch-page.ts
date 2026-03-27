/**
 * Fetch Page Built-in Tool
 *
 * Lightweight HTTP fetch — no browser, no Browserless cost.
 * Returns response headers, body text, and extracted internal links.
 * Use for: sitemap.xml, robots.txt, SEO meta extraction, page discovery.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import { urlInput } from "./browserless";

export const InputSchema = z.object({
  url: urlInput.describe("The URL to fetch"),
  extractLinks: z
    .boolean()
    .default(true)
    .describe("Extract internal links from HTML responses"),
  maxBodyKB: z
    .number()
    .max(2048)
    .default(512)
    .describe("Max response body to return (KB). Truncated beyond this."),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Custom request headers (e.g. Accept, User-Agent)"),
  cookies: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Cookies to set on the request as key-value pairs, e.g. { '_deco_bucket': 'worker' }",
    ),
});

const DEFAULT_UA = "Mozilla/5.0 (compatible; DecoBot/1.0; +https://deco.cx)";

/** Extract href values from <a> tags, handling both quotes and edge cases */
function extractLinks(html: string, baseUrl: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  const regex = /href=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  while ((match = regex.exec(html)) !== null) {
    const raw = match[1];
    if (!raw || raw.startsWith("#") || raw.startsWith("javascript:")) continue;

    try {
      const resolved = new URL(raw, baseUrl);
      // Only internal links (same hostname)
      if (resolved.hostname !== base.hostname) continue;
      // Normalize: drop hash, keep path + query
      const normalized = `${resolved.origin}${resolved.pathname}${resolved.search}`;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        results.push(normalized);
      }
    } catch {
      // skip malformed URLs
    }
  }

  return results;
}

/** Parse sitemap.xml and extract <loc> URLs */
function extractSitemapUrls(xml: string): string[] {
  const urls: string[] = [];
  const regex = /<loc>\s*([^<]+)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    const url = match[1]?.trim();
    if (url) urls.push(url);
  }

  return urls;
}

/** Extract SEO-relevant meta tags from HTML */
function extractSeoMeta(html: string): Record<string, string> {
  const meta: Record<string, string> = {};

  // <title>
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch?.[1]) meta.title = titleMatch[1].trim();

  // <meta name="..." content="..."> and <meta property="..." content="...">
  const metaRegex =
    /<meta\s+(?:name|property)=["']([^"']+)["']\s+content=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = metaRegex.exec(html)) !== null) {
    const key = match[1]?.toLowerCase();
    const value = match[2];
    if (key && value) meta[key] = value;
  }
  // Also match reversed attribute order: content before name/property
  const metaRegex2 =
    /<meta\s+content=["']([^"']+)["']\s+(?:name|property)=["']([^"']+)["']/gi;
  while ((match = metaRegex2.exec(html)) !== null) {
    const value = match[1];
    const key = match[2]?.toLowerCase();
    if (key && value) meta[key] = value;
  }

  // <link rel="canonical">
  const canonicalMatch = html.match(
    /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i,
  );
  if (canonicalMatch?.[1]) meta.canonical = canonicalMatch[1];

  // JSON-LD types
  const jsonLdRegex =
    /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const jsonLdTypes: string[] = [];
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]!);
      if (data["@type"]) jsonLdTypes.push(data["@type"]);
      if (Array.isArray(data["@graph"])) {
        for (const item of data["@graph"]) {
          if (item["@type"]) jsonLdTypes.push(item["@type"]);
        }
      }
    } catch {
      // skip malformed JSON-LD
    }
  }
  if (jsonLdTypes.length > 0) meta["json-ld"] = jsonLdTypes.join(", ");

  // hreflang
  const hreflangRegex =
    /<link\s+rel=["']alternate["']\s+hreflang=["']([^"']+)["']\s+href=["']([^"']+)["']/gi;
  const hreflangs: string[] = [];
  while ((match = hreflangRegex.exec(html)) !== null) {
    if (match[1] && match[2]) hreflangs.push(`${match[1]}:${match[2]}`);
  }
  if (hreflangs.length > 0) meta.hreflang = hreflangs.join(", ");

  return meta;
}

export function createFetchPageTool() {
  return tool({
    description:
      "Fetch a URL via HTTP (no browser needed — fast and free). " +
      "Returns headers, body, internal links, and SEO meta tags. " +
      "Use for: sitemap.xml, robots.txt, HTML page SEO audit, link discovery. " +
      "Much faster than capture_har — use this for discovery and SEO checks.",
    inputSchema: zodSchema(InputSchema),
    execute: async (input: z.infer<typeof InputSchema>) => {
      const maxBytes = input.maxBodyKB * 1024;

      try {
        // Build cookie header from key-value pairs
        const cookieHeader = input.cookies
          ? Object.entries(input.cookies)
              .map(([k, v]) => `${k}=${v}`)
              .join("; ")
          : undefined;

        const res = await fetch(input.url, {
          method: "GET",
          headers: {
            "User-Agent": DEFAULT_UA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            ...input.headers,
          },
          redirect: "follow",
          signal: AbortSignal.timeout(15_000),
        });

        // Collect response headers
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        // Read body with size limit
        const contentType = res.headers.get("content-type") ?? "";
        const reader = res.body?.getReader();
        let body = "";
        let totalBytes = 0;
        let truncated = false;

        if (reader) {
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes <= maxBytes) {
              body += decoder.decode(value, { stream: true });
            } else {
              truncated = true;
              // Include up to the limit
              const remaining = maxBytes - (totalBytes - value.byteLength);
              if (remaining > 0) {
                body += decoder.decode(value.slice(0, remaining));
              }
              reader.cancel().catch(() => {});
              break;
            }
          }
        }

        const isHtml = contentType.includes("html");
        const isXml = contentType.includes("xml") || input.url.endsWith(".xml");

        // Extract data based on content type
        let links: string[] | undefined;
        let sitemapUrls: string[] | undefined;
        let seo: Record<string, string> | undefined;

        if (isXml && body.includes("<loc>")) {
          sitemapUrls = extractSitemapUrls(body);
        }

        if (isHtml) {
          if (input.extractLinks) {
            links = extractLinks(body, input.url);
          }
          seo = extractSeoMeta(body);
        }

        return {
          url: input.url,
          finalUrl: res.url !== input.url ? res.url : undefined,
          status: res.status,
          headers: responseHeaders,
          contentType,
          bodyKB: Math.round(totalBytes / 1024),
          truncated,
          body: truncated ? body + "\n...[truncated]" : body,
          ...(links ? { links } : {}),
          ...(sitemapUrls ? { sitemapUrls } : {}),
          ...(seo ? { seo } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          url: input.url,
          error: message,
          status: 0,
        };
      }
    },
  });
}

/**
 * Render Page Built-in Tool
 *
 * Uses a real browser to get fully rendered HTML (after JS execution).
 * Dual-mode: Browserless /content REST API (remote) or local Playwright Chromium.
 * For SPAs and JS-heavy sites where fetch_page only returns a skeleton.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import {
  urlInput,
  getBrowserMode,
  getBrowserlessToken,
  getHttpBaseUrl,
  withBrowserPage,
  resolveBrowserEndpoint,
} from "./browserless";

export const InputSchema = z.object({
  url: urlInput.describe("The URL to render"),
  waitForSelector: z
    .string()
    .optional()
    .describe(
      "CSS selector to wait for before capturing (e.g. '#main-content')",
    ),
  waitForTimeout: z
    .number()
    .max(30000)
    .optional()
    .describe("Extra milliseconds to wait after page load"),
  rejectResourceTypes: z
    .array(z.enum(["image", "font", "media", "stylesheet"]))
    .default(["image", "font", "media"])
    .describe(
      "Resource types to block for faster rendering (images/fonts not needed for DOM)",
    ),
  extractText: z
    .boolean()
    .default(true)
    .describe("Extract visible text content from the rendered page"),
  extractMeta: z
    .boolean()
    .default(true)
    .describe("Extract meta tags, title, headings, and structured data"),
  maxContentKB: z
    .number()
    .default(100)
    .describe("Max HTML content size in KB to return (truncated if larger)"),
});

export function createRenderPageTool() {
  return tool({
    description:
      "Render a URL with a real browser (JS execution). " +
      "Returns the fully rendered DOM HTML, visible text, and meta tags. " +
      "Use when fetch_page returns empty/skeleton HTML (SPAs, client-rendered sites). " +
      "Slower than fetch_page — prefer fetch_page when SSR HTML is sufficient.",
    inputSchema: zodSchema(InputSchema),
    execute: async (input: z.infer<typeof InputSchema>) => {
      const mode = getBrowserMode();

      let html: string;

      if (mode === "remote") {
        // Remote mode — use Browserless /content REST API
        html = await fetchRenderedContent(input);
      } else {
        // Local mode — use local Chromium via puppeteer
        html = await localRenderContent(input);
      }

      const maxBytes = input.maxContentKB * 1024;
      const truncated = html.length > maxBytes;

      const result: Record<string, unknown> = {
        url: input.url,
        contentLength: html.length,
        truncated,
      };

      if (input.extractMeta) {
        result.meta = extractMeta(html);
      }

      if (input.extractText) {
        result.text = extractVisibleText(html).slice(0, maxBytes);
      }

      if (html.length <= maxBytes) {
        result.html = truncated ? html.slice(0, maxBytes) : html;
      }

      return result;
    },
  });
}

/** Remote: use Browserless /content REST API */
async function fetchRenderedContent(
  input: z.infer<typeof InputSchema>,
): Promise<string> {
  const token = getBrowserlessToken();
  const baseUrl = getHttpBaseUrl();
  const endpoint = `${baseUrl}/content?token=${token}`;

  const body: Record<string, unknown> = {
    url: input.url,
    rejectResourceTypes: input.rejectResourceTypes,
    bestAttempt: true,
    gotoOptions: { waitUntil: "networkidle2", timeout: 30000 },
  };

  if (input.waitForSelector) {
    body.waitForSelector = { selector: input.waitForSelector, timeout: 10000 };
  }
  if (input.waitForTimeout) {
    body.waitForTimeout = input.waitForTimeout;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Browserless /content returned ${response.status}: ${text.slice(0, 200)}`,
    );
  }

  return response.text();
}

/** Local: use puppeteer to navigate and extract page.content() */
async function localRenderContent(
  input: z.infer<typeof InputSchema>,
): Promise<string> {
  const endpoint = resolveBrowserEndpoint();
  return withBrowserPage(endpoint, "desktop", async (page) => {
    // Block resource types for speed
    if (input.rejectResourceTypes?.length) {
      await page.setRequestInterception(true);
      const blocked = new Set<string>(input.rejectResourceTypes);
      page.on("request", (req) => {
        if (blocked.has(req.resourceType())) {
          req.abort();
        } else {
          req.continue();
        }
      });
    }

    await page.goto(input.url, { waitUntil: "networkidle2", timeout: 30000 });

    if (input.waitForSelector) {
      await page
        .waitForSelector(input.waitForSelector, { timeout: 10000 })
        .catch(() => {});
    }
    if (input.waitForTimeout) {
      await new Promise((r) => setTimeout(r, input.waitForTimeout!));
    }

    return page.content();
  });
}

/** Extract meta information from rendered HTML */
function extractMeta(html: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {};

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  meta.title = titleMatch?.[1]?.trim() ?? null;

  const descMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*?)["']/i,
  );
  meta.description = descMatch?.[1] ?? null;

  const canonMatch = html.match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*?)["']/i,
  );
  meta.canonical = canonMatch?.[1] ?? null;

  const ogTags: Record<string, string> = {};
  const ogRegex =
    /<meta[^>]+property=["'](og:[^"']+)["'][^>]+content=["']([^"']*?)["']/gi;
  let ogMatch;
  while ((ogMatch = ogRegex.exec(html)) !== null) {
    if (ogMatch[1] && ogMatch[2]) ogTags[ogMatch[1]] = ogMatch[2];
  }
  if (Object.keys(ogTags).length > 0) meta.og = ogTags;

  const headings: { level: number; text: string }[] = [];
  const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let hMatch;
  while ((hMatch = headingRegex.exec(html)) !== null) {
    const text = hMatch[2]?.replace(/<[^>]+>/g, "").trim();
    if (text) headings.push({ level: Number(hMatch[1]), text });
  }
  if (headings.length > 0) meta.headings = headings.slice(0, 30);

  const jsonLdRegex =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const jsonLd: unknown[] = [];
  let ldMatch;
  while ((ldMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      if (ldMatch[1]) jsonLd.push(JSON.parse(ldMatch[1]));
    } catch {
      // skip malformed JSON-LD
    }
  }
  if (jsonLd.length > 0) meta.jsonLd = jsonLd;

  return meta;
}

/** Strip HTML tags and extract visible text */
function extractVisibleText(html: string): string {
  let text = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

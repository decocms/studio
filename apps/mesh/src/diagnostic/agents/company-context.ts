/**
 * Company Context Agent
 *
 * Crawls multiple pages (homepage + navigation) and generates a two-paragraph
 * AI description of the company using a configurable LLM provider.
 * Standalone async function — no MeshContext dependency.
 */

import { crawlMultiplePages } from "../crawl";
import type { CrawlResult } from "../crawl";

export interface CompanyContextResult {
  description?: string;
  crawledPages: string[];
  productSignals: string[];
  targetAudience?: string;
  competitiveAngle?: string;
}

const SYSTEM_PROMPT = `You are analyzing an e-commerce storefront. Based on the following homepage and additional page content, write a company context description.

Write exactly two paragraphs in a conversational, friendly tone — like explaining this business to a colleague:
- First paragraph: What does this store sell? Who is their target customer?
- Second paragraph: What's their competitive positioning? What market category are they in?

Keep it concise — 3-4 sentences per paragraph maximum. Be specific about products and audience. If you can't determine something, say so briefly rather than guessing.`;

const PAGE_PRIORITY_KEYWORDS = [
  "about",
  "company",
  "who-we-are",
  "about-us",
  "nossa-historia",
  "sobre",
  "quem-somos",
  "a-empresa",
  "history",
  "mission",
];

/**
 * Strip HTML tags and normalize whitespace for LLM consumption.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract navigation links from HTML, filtered to same-origin and prioritized
 * by relevance keywords (About, Company, etc.).
 */
function extractNavigationLinks(html: string, baseUrl: string): string[] {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return [];
  }

  const linkPattern = /<a\s[^>]*href\s*=\s*["']([^"'#?]+)["'][^>]*>/gi;
  const seen = new Set<string>();
  const links: Array<{ url: string; priority: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html)) !== null) {
    const href = match[1];
    if (!href) continue;

    let resolvedUrl: string;
    try {
      resolvedUrl = new URL(href, baseUrl).href;
    } catch {
      continue;
    }

    // Same-origin only
    if (!resolvedUrl.startsWith(origin)) continue;

    // Skip common non-content paths
    const pathname = new URL(resolvedUrl).pathname.toLowerCase();
    if (
      pathname === "/" ||
      pathname.match(/\.(jpg|jpeg|png|gif|svg|pdf|zip|css|js)$/i) ||
      pathname.startsWith("/cart") ||
      pathname.startsWith("/checkout") ||
      pathname.startsWith("/search") ||
      pathname.startsWith("/account") ||
      pathname.startsWith("/login") ||
      pathname.startsWith("/signin")
    ) {
      continue;
    }

    if (seen.has(resolvedUrl)) continue;
    seen.add(resolvedUrl);

    // Prioritize pages with about/company keywords
    const priority = PAGE_PRIORITY_KEYWORDS.some((kw) => pathname.includes(kw))
      ? 1
      : 0;

    links.push({ url: resolvedUrl, priority });
  }

  // Sort by priority (about/company pages first)
  links.sort((a, b) => b.priority - a.priority);

  return links.map((l) => l.url);
}

/**
 * Extract product signals from HTML text content.
 * Looks for schema.org product types, price patterns, and product grids.
 */
function extractProductSignals(html: string): string[] {
  const signals: string[] = [];

  // Schema.org product types
  if (/"@type"\s*:\s*"Product"/i.test(html)) {
    signals.push("schema.org Product markup detected");
  }
  if (/"@type"\s*:\s*"Offer"/i.test(html)) {
    signals.push("schema.org Offer markup detected");
  }
  if (/"@type"\s*:\s*"ItemList"/i.test(html)) {
    signals.push("schema.org ItemList markup detected");
  }

  // Price patterns (R$, $, €, £ followed by numbers)
  const pricePattern = /(?:R\$|USD|\$|€|£)\s*\d+[\d,.]+/g;
  const priceMatches = html.match(pricePattern);
  if (priceMatches && priceMatches.length > 0) {
    signals.push(
      `Price patterns detected (${Math.min(priceMatches.length, 10)} instances)`,
    );
  }

  // Product grid signals
  if (/product[-_]grid|product[-_]list|shelf|prateleira/i.test(html)) {
    signals.push("Product grid/shelf layout detected");
  }

  // Add-to-cart signals
  if (
    /add[-\s]?to[-\s]?cart|adicionar[-\s]?ao[-\s]?carrinho|comprar/i.test(html)
  ) {
    signals.push("Add-to-cart functionality detected");
  }

  // Free shipping signals
  if (/free[-\s]?shipping|frete[-\s]?gr[aá]tis/i.test(html)) {
    signals.push("Free shipping messaging present");
  }

  return signals;
}

/**
 * Create LLM provider model based on environment configuration.
 * Returns null if no API key is configured.
 */
async function createLlmModel(): Promise<unknown | null> {
  const provider = process.env["DIAGNOSTIC_LLM_PROVIDER"] ?? "openai";
  const apiKey = process.env["DIAGNOSTIC_LLM_API_KEY"];
  const model = process.env["DIAGNOSTIC_LLM_MODEL"] ?? "gpt-4o-mini";

  if (!apiKey) {
    console.warn(
      "[diagnostic:company-context] No LLM API key configured, skipping AI company description",
    );
    return null;
  }

  type CreateFn = (opts: { apiKey: string }) => (model: string) => unknown;

  try {
    if (provider === "openai") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await import("@ai-sdk/openai" as any);
      const { createOpenAI } = mod as { createOpenAI: CreateFn };
      return createOpenAI({ apiKey })(model);
    }

    if (provider === "anthropic") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await import("@ai-sdk/anthropic" as any);
      const { createAnthropic } = mod as { createAnthropic: CreateFn };
      return createAnthropic({ apiKey })(model);
    }

    if (provider === "google") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await import("@ai-sdk/google" as any);
      const { createGoogleGenerativeAI } = mod as {
        createGoogleGenerativeAI: CreateFn;
      };
      return createGoogleGenerativeAI({ apiKey })(model);
    }

    console.warn(
      `[diagnostic:company-context] Unknown LLM provider: ${provider}, defaulting to openai`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import("@ai-sdk/openai" as any);
    const { createOpenAI } = mod as { createOpenAI: CreateFn };
    return createOpenAI({ apiKey })(model);
  } catch (error) {
    console.warn(
      `[diagnostic:company-context] Failed to create LLM provider ${provider}: ${(error as Error).message}`,
    );
    return null;
  }
}

/**
 * Generate a company description using the configured LLM.
 * Returns null if LLM is not configured or fails.
 */
async function generateCompanyDescription(
  pageContents: Array<{ url: string; text: string }>,
): Promise<string | undefined> {
  const llmModel = await createLlmModel();
  if (!llmModel) return undefined;

  // Build user prompt from page contents
  const userContent = pageContents
    .map(({ url, text }, idx) => {
      const maxChars = idx === 0 ? 3000 : 1500; // Homepage gets more space
      const truncated = text.slice(0, maxChars);
      return `=== Page: ${url} ===\n${truncated}`;
    })
    .join("\n\n");

  try {
    const { generateText } = await import("ai");
    const result = await generateText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: llmModel as any,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      maxOutputTokens: 500,
      temperature: 0.3,
    });

    return result.text.trim() || undefined;
  } catch (error) {
    console.warn(
      `[diagnostic:company-context] LLM call failed: ${(error as Error).message}`,
    );
    return undefined;
  }
}

/**
 * Run the company context diagnostic agent.
 * Crawls homepage + navigation pages, then generates an AI company description.
 */
export async function runCompanyContextAgent(
  url: string,
  crawl: CrawlResult,
): Promise<CompanyContextResult> {
  const crawledPages: string[] = [crawl.url];

  // Extract navigation links from homepage
  const navLinks = extractNavigationLinks(crawl.html, url);

  // Crawl up to 3 additional pages with 15s timeout
  const additionalResults = await crawlMultiplePages(navLinks, {
    timeoutMs: 15_000,
    maxPages: 3,
  });

  for (const r of additionalResults) {
    crawledPages.push(r.url);
  }

  // Build page contents for LLM
  const pageContents = [
    { url: crawl.url, text: stripHtml(crawl.html) },
    ...additionalResults.map((r) => ({
      url: r.url,
      text: stripHtml(r.html),
    })),
  ];

  // Extract product signals from homepage
  const productSignals = extractProductSignals(crawl.html);

  // Generate AI description
  const description = await generateCompanyDescription(pageContents);

  return {
    description,
    crawledPages,
    productSignals,
    targetAudience: undefined, // Derived from LLM output in future
    competitiveAngle: undefined, // Derived from LLM output in future
  };
}

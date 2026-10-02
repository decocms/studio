/**
 * What the web knows about a brand that the brand's own site does not say.
 *
 * Three fields are structurally unanswerable from a site's own blocks: a brand
 * does not name its rivals, does not argue why it beats them, and does not
 * publish the commercial calendar it plans around. Reading harder does not
 * help; only searching does.
 *
 * Runs on the org's `web_search` tier when it has one, and is pure enrichment:
 * every failure path returns empty and lets the extract succeed without it.
 */

import { generateText } from "ai";
import { z } from "zod";
import { resolveTier, tryResolveTier } from "../../core/resolve-tier";
import { retryGenerateObject } from "./generate-object";
import { BrandRuleSchema } from "./schema";

const SYSTEM = `You turn a web-research summary into a structured brand profile.

Split the research into three lists. \`competitors\`: who this brand competes with, \`name\` the rival and \`value\` how it positions itself and where it differs — the angle a writer needs in order not to sound like them. \`differentiators\`: what this brand has that a rival cannot claim, \`value\` stating the claim and what backs it. \`specialDates\`: the commercial moments this brand's year turns around, \`value\` explaining what the date means FOR THIS BRAND — what it sells then, what it says then.

Write every \`value\` in the language given as the brand's, not in the language of the research text or of these instructions. This sits alongside the rest of the brand profile and is fed to a model that copies the language it sees.

ONLY USE WHAT THE RESEARCH TEXT ACTUALLY SAYS. Never fill a list from what you know about the market segment. An invented competitor or an invented date becomes a false premise in every post generated afterwards, and the person reviewing this has no way to tell it apart from a real one. An empty list is a correct answer.

Special dates are the one place this is tempting, because every retailer has a Black Friday. Include a general retail date ONLY when the research text ties it to this brand specifically, and say in \`value\` what the research said about it.`;

const BrandResearchObjectSchema = z.object({
  competitors: z.array(BrandRuleSchema),
  differentiators: z.array(BrandRuleSchema),
  specialDates: z.array(BrandRuleSchema),
});

export interface BrandResearch
  extends z.infer<typeof BrandResearchObjectSchema> {
  /** URLs the search model cited, deduped. What makes a claim checkable. */
  sources: string[];
  /** False when the org has no `web_search` tier, or the search failed. */
  searched: boolean;
}

const EMPTY: BrandResearch = {
  competitors: [],
  differentiators: [],
  specialDates: [],
  sources: [],
  searched: false,
};

/** Citation URLs the search model reported, deduped and capped. */
const MAX_SOURCES = 20;

function urlSources(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const record = source as { sourceType?: unknown; url?: unknown };
    if (record?.sourceType !== "url" || typeof record.url !== "string")
      continue;
    if (seen.has(record.url)) continue;
    seen.add(record.url);
    urls.push(record.url);
    if (urls.length >= MAX_SOURCES) break;
  }
  return urls;
}

export interface ResearchBrandInput {
  companyName: string;
  description: string;
  language: string;
  targetAudience?: string;
}

/**
 * One search, then one pass to structure it.
 *
 * Searching per concern would triple the latency and the cost to get heavily
 * overlapping text back — a search-capable model already fans out internally,
 * and the separation that matters happens in the structuring pass anyway.
 */
export async function researchBrand(
  ctx: Parameters<typeof resolveTier>[0],
  organizationId: string,
  brand: ResearchBrandInput,
): Promise<BrandResearch> {
  if (!brand.companyName.trim()) return EMPTY;
  const searchTier = await tryResolveTier(ctx, "web_search");
  if (!searchTier) return EMPTY;

  try {
    const searchProvider = await ctx.aiProviders.activate(
      searchTier.credentialId,
      organizationId,
    );
    const { text, sources } = await generateText({
      model: searchProvider.aiSdk.languageModel(searchTier.modelId),
      prompt: [
        `Research the brand ${brand.companyName}.`,
        brand.description && `What it does: ${brand.description}`,
        brand.targetAudience && `Who it sells to: ${brand.targetAudience}`,
        "",
        "Answer these four, in order, naming your sources:",
        `1. Who are its main competitors? For each, how it positions itself and how it differs from ${brand.companyName}.`,
        `2. What is ${brand.companyName} known for that its competitors are not? Name the evidence.`,
        `3. Which commercial dates does it actually run campaigns on? Include both its own recurring moments (a brand-named week or anniversary sale) and the general retail dates of its country and segment, but only those you can tie to this brand. For each, say what it does on that date.`,
        `4. How do the market and the press describe its positioning?`,
        "",
        `Search in the brand's own market and language (${brand.language || "unknown"}) — local sources matter more than global ones. Say so plainly where you find little, rather than filling the gap.`,
      ]
        .filter((line) => typeof line === "string")
        .join("\n"),
    });
    if (!text.trim()) return EMPTY;

    const citations = urlSources(sources);
    const smartTier = await resolveTier(ctx, "smart");
    const smartProvider = await ctx.aiProviders.activate(
      smartTier.credentialId,
      organizationId,
    );
    const { object } = await retryGenerateObject({
      model: smartProvider.aiSdk.languageModel(smartTier.modelId),
      schema: BrandResearchObjectSchema,
      system: SYSTEM,
      prompt: [
        `Brand: ${brand.companyName}`,
        `Write the values in: ${brand.language || "the brand's own language"}`,
        "",
        `Research:\n${text}`,
        citations.length ? `\nSources cited:\n${citations.join("\n")}` : "",
      ].join("\n"),
    });

    return { ...object, sources: citations, searched: true };
  } catch (err) {
    console.warn("[BLOG_BRAND_EXTRACT] brand research failed", err);
    return EMPTY;
  }
}

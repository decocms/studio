import { generateObject, generateText } from "ai";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { resolveTier, tryResolveTier } from "../../core/resolve-tier";

/**
 * One editorial rule: a short name plus a markdown body. Flat strings could not
 * carry a rule worth writing down ("never print prices in a text block, use
 * ProductCard") nor a competitor worth naming (a name alone says nothing about
 * how the brand differs from it).
 */
const BrandRuleSchema = z.object({
  name: z
    .string()
    .describe("Short phrase naming the rule — what it is about, not the rule"),
  value: z
    .string()
    .describe(
      "The rule itself, as markdown. One or two paragraphs; use a bullet list only when there are genuinely several cases. No heading — the name is the heading.",
    ),
});

/**
 * Editorial brand context for blogpost generation. Field names match Spire's
 * `blog-manager-brand.json`; `normalizeBrandRules` (web) reads the older
 * `string[]` rule lists too.
 */
const BlogBrandSchema = z.object({
  companyName: z
    .string()
    .describe(
      "The store or brand name. Look for the name that recurs across page titles, block `name` props, and post bodies — not a product or category name.",
    ),
  description: z
    .string()
    .describe(
      "What the company sells and who it sells to, 1-3 sentences. Look at the home and institutional pages.",
    ),
  language: z
    .string()
    .describe(
      "BCP-47 tag of the language the prose itself is written in, e.g. pt-BR. Read the post bodies, not any locale config.",
    ),
  tone: z
    .string()
    .describe(
      "Tone of voice, described so another writer could reproduce it: how the reader is addressed (which pronoun, which person), sentence length, humor, jargon level, formality, and casing conventions. Read the longest run of real prose you can find — post bodies if they exist, otherwise page copy and meta descriptions.",
    ),
  targetAudience: z
    .string()
    .describe(
      "Who reads this brand's content and what they came looking for. Infer from who the copy addresses and what it assumes the reader already cares about. Say so plainly rather than reaching for marketing personas.",
    ),
  values: z
    .array(BrandRuleSchema)
    .describe(
      "Brand values the content should carry, as the brand itself states them. `name` is the value ('Biodiversidade brasileira'), `value` explains what the copy actually claims and the evidence for it — stated numbers, sourcing commitments. Prefer a value the copy argues for over a generic virtue like 'quality' or 'innovation'.",
    ),
  dos: z
    .array(BrandRuleSchema)
    .describe(
      "Instructions a blogpost writer must follow for this brand, derived from patterns the copy consistently follows. `name` names the rule ('Abertura do post'), `value` is the imperative instruction — instructions, not adjectives: 'Open with the customer's problem, never with the company' beats 'customer-focused'. Any brand-specific word for an ordinary thing gets its own rule, quoted: \"call the shopping bag 'mochila', never 'carrinho'\".",
    ),
  avoid: z
    .array(BrandRuleSchema)
    .describe(
      "Things a blogpost writer must not do — banned words, claims, formats, topics. `name` names the guardrail, `value` states the prohibition and why the copy suggests it. Derive them from what the copy consistently never does and from claims the brand is visibly careful about. Do not restate a `dos` entry inverted.",
    ),
  categories: z
    .array(z.string())
    .describe(
      "Content categories that fit this brand's blog, as plain names — this is a taxonomy, not a rule, so no body. Take existing category blocks first; with no blog, derive them from the themes the site's own pages keep returning to. Editorial subjects, not the product taxonomy.",
    ),
  competitors: z
    .array(BrandRuleSchema)
    .describe(
      "Competitors named explicitly in the content. A brand rarely names them in its own copy — return an empty array unless a name is actually there, and never guess from the market segment. When one is named, `name` is the competitor and `value` is what the content says about it.",
    ),
});

const SYSTEM = `You are filling in a brand's editorial profile so that blogposts generated later sound like the brand wrote them itself. Every field of the output schema says what it wants and where to find it — work through them field by field.

Your input is Deco CMS blocks from a site's own repository, serialized as JSON and labelled with their block keys. Blog post and category blocks are the strongest evidence when they exist, because that is the brand writing posts. Many commerce sites have no blog at all, only page blocks (they carry a \`path\` and a \`sections\` array) — then page copy is all you get, and you work with it.

Prose is scattered across prop names, not held in one body field. Harvest it from every prop whose value reads like a sentence or a phrase a person wrote: \`text\`, \`title\`, \`description\`, \`label\`, \`caption\`, \`alt\`, and HTML fragments stored as strings (\`"<p>…</p>"\` — read through the tags). Short values count: \`alt: "92% de funcionárias"\` and \`alt: "do rio pro mundo"\` tell you more about a brand than a whole layout tree.

Four traps in real block data:

1. INTERNAL ANNOTATIONS ARE NOT COPY. Editors label assets for themselves: \`"[LP Rio - lojix] [carrossel detalhes]"\`, \`"Banner lojix"\`, \`"Desktop"\`, \`"20px"\`. Bracketed prefixes, campaign codenames, asset filenames and dimension labels are internal shorthand. Never quote them as brand voice.

2. OPERATIONAL AND LEGAL COPY IS NOT EDITORIAL VOICE. Shipping thresholds, return windows, payment restrictions and promotion terms are written by a different hand for a different purpose. Read them for facts if a field needs one, never for tone — treating them as voice yields fine print instead of a brand.

3. BRAND-SPECIFIC VOCABULARY IS THE MOST VALUABLE THING HERE. When a brand renames an ordinary thing, capture it verbatim as a \`dos\` entry: a site that writes "verifique os detalhes direto na sua mochila" calls the shopping bag a *mochila*, and one that writes "o seu desejo tamanho M não está disponível" calls a product a *desejo*. A generated post that says "carrinho" instead would read as an impostor. Same for recurring one-word imperatives the brand uses as sign-offs ("vem").

4. CASING AND PUNCTUATION ARE PART OF THE VOICE. If sentences and the brand's own name are consistently lowercase, that is a deliberate choice and belongs in \`tone\` and in \`dos\`. Watch for inconsistency too: when the same sentence appears in two casings, the brand has no settled rule, so do not invent one.

Template placeholders like \`{size}\` or \`{name}\` are slots the site fills at render time. Read the sentence around them; never copy the placeholder into your answer.

Two rules that override everything else:
1. Every field must rest on prose you actually read here. Fidelity to how THIS brand writes beats how a brand in its category usually writes.
2. No evidence means empty — an empty string or an empty array. A plausible-sounding guess is worse than a blank field, because someone will read it as fact and every post generated afterwards inherits it. A human reviews this afterwards and can fill a blank; they cannot un-read a confident invention.`;

/** Caps on what a client may send — the request body is a trust boundary. */
const MAX_BLOCKS = 60;
const MAX_BLOCK_CHARS = 12_000;

const COMPETITOR_SYSTEM = `You turn a web-research summary into a list of a brand's competitors.

For each competitor: \`name\` is the competitor's name, \`value\` is markdown covering how it positions itself and where it differs from the brand in question — the angle a writer would need to avoid sounding like them.

Only list competitors the research text actually names. If it names none, return an empty array. Never fill the list from what you know about the market segment: this list drives generated content, and an invented competitor becomes a false premise in every post that reads it.`;

const CompetitorsSchema = z.object({
  competitors: z.array(BrandRuleSchema),
});

/**
 * Competitors are the one field a site's own blocks cannot answer — a brand does
 * not name its rivals in its own copy. So when the org has a `web_search` tier,
 * search for them.
 *
 * `mode: "quick"` of the chat harness's research hook reduces to a plain call
 * against the search-capable model (`cluster-research-job.ts` → `runStreamingResearch`),
 * so this does the same with `generateText` instead of importing the harness and
 * inventing a `taskId`/`toolCallId` for a durable job it doesn't need.
 *
 * Returns `[]` when the org has no `web_search` tier configured, when the search
 * yields nothing, or on any failure: this enriches the result, it must never be
 * what makes the extract fail.
 */
async function searchCompetitors(
  ctx: Parameters<typeof resolveTier>[0],
  organizationId: string,
  brand: { companyName: string; description: string },
): Promise<z.infer<typeof BrandRuleSchema>[]> {
  if (!brand.companyName.trim()) return [];
  const searchTier = await tryResolveTier(ctx, "web_search");
  if (!searchTier) return [];

  try {
    const searchProvider = await ctx.aiProviders.activate(
      searchTier.credentialId,
      organizationId,
    );
    const { text } = await generateText({
      model: searchProvider.aiSdk.languageModel(searchTier.modelId),
      prompt: `Who are the main competitors of ${brand.companyName}? Context on the company: ${brand.description}\n\nFor each competitor, say how it positions itself and how it differs from ${brand.companyName}. Name only companies you can actually source.`,
    });
    if (!text.trim()) return [];

    const smartTier = await resolveTier(ctx, "smart");
    const smartProvider = await ctx.aiProviders.activate(
      smartTier.credentialId,
      organizationId,
    );
    const { object } = await generateObject({
      model: smartProvider.aiSdk.languageModel(smartTier.modelId),
      schema: CompetitorsSchema,
      system: COMPETITOR_SYSTEM,
      prompt: `Brand: ${brand.companyName}\n\nResearch:\n${text}`,
      temperature: 0.2,
    });
    return object.competitors;
  } catch (err) {
    console.warn("[BLOG_BRAND_EXTRACT] competitor search failed", err);
    return [];
  }
}

export const BLOG_BRAND_EXTRACT = defineTool({
  name: "BLOG_BRAND_EXTRACT",
  description:
    "Infer a site's editorial brand context (tone of voice, dos and don'ts, audience, categories) by reading its own CMS blocks. Does not persist — the caller saves the result to the site's blog-manager-brand.json block.",
  annotations: {
    title: "Extract Editorial Brand",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    blocks: z
      .array(
        z.object({
          key: z
            .string()
            .max(512)
            .describe("Decofile block key, e.g. collections/blog/posts/abc"),
          content: z
            .string()
            .max(MAX_BLOCK_CHARS)
            .describe("The block's JSON, serialized"),
        }),
      )
      .min(1)
      .max(MAX_BLOCKS)
      .describe(
        "Blocks to read, most telling first — existing blogposts, then categories, then pages.",
      ),
  }),

  outputSchema: BlogBrandSchema.extend({
    sources: z.array(z.string()).describe("Block keys the inference read"),
    searchedCompetitors: z
      .boolean()
      .describe(
        "True when the blocks named no competitor, so a web search was attempted. An empty `competitors` alongside this means the search found none, or the org has no web_search tier.",
      ),
  }),

  modelSummary: (r) =>
    `Editorial brand inferred for ${r.companyName} from ${r.sources.length} block(s): tone captured, ${r.dos.length} dos, ${r.avoid.length} don'ts, ${r.categories.length} categories, ${r.competitors.length} competitors${r.searchedCompetitors ? " (from web search)" : ""}. Not yet saved.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const tier = await resolveTier(ctx, "smart");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organizationId,
    );

    const { object } = await generateObject({
      model: provider.aiSdk.languageModel(tier.modelId),
      schema: BlogBrandSchema,
      system: SYSTEM,
      prompt: input.blocks
        .map((b) => `# Block: ${b.key}\n\n${b.content}`)
        .join("\n\n---\n\n"),
      temperature: 0.2,
    });

    // The blocks can't name competitors, so search only when they didn't.
    const competitors =
      object.competitors.length > 0
        ? object.competitors
        : await searchCompetitors(ctx, organizationId, object);

    return {
      ...object,
      competitors,
      searchedCompetitors: object.competitors.length === 0,
      sources: input.blocks.map((b) => b.key),
    };
  },
});

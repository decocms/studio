import { generateObject } from "ai";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { resolveTier } from "../../core/resolve-tier";

/**
 * Editorial brand context for blogpost generation.
 *
 * Field names match Spire's `blog-manager-brand.json` (`server/core/tools/context.ts`)
 * so a site whose block Spire already wrote stays readable here — `avoid` is the
 * don'ts list, `dos` is the only field this surface adds.
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
    .array(z.string())
    .describe(
      "Brand values the content should carry, as the brand itself states them. Institutional copy is the best source — sustainability claims, sourcing commitments, stated numbers. Prefer a value the copy actually argues for over a generic virtue like 'quality' or 'innovation'.",
    ),
  dos: z
    .array(z.string())
    .describe(
      "Imperative instructions a blogpost writer must follow for this brand. Derive them from patterns the copy consistently follows. Instructions, not adjectives: 'Open with the customer's problem, never with the company' beats 'customer-focused'. Any brand-specific word for an ordinary thing belongs here, quoted: \"call the shopping bag 'mochila', never 'carrinho'\".",
    ),
  avoid: z
    .array(z.string())
    .describe(
      "Imperative things a blogpost writer must not do — banned words, claims, formats, topics. Derive them from what the copy consistently never does, and from any claim the brand is visibly careful about. Do not restate a `dos` entry inverted.",
    ),
  categories: z
    .array(z.string())
    .describe(
      "Content categories that fit this brand's blog. Take existing category blocks first; with no blog, derive them from the themes the site's own pages keep returning to. Editorial subjects, not the product taxonomy.",
    ),
  competitors: z
    .array(z.string())
    .describe(
      "Competitors named explicitly in the content. A brand rarely names them in its own copy — return an empty array unless a name is actually there. Never guess from the market segment.",
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
  }),

  modelSummary: (r) =>
    `Editorial brand inferred for ${r.companyName} from ${r.sources.length} block(s): tone captured, ${r.dos.length} dos, ${r.avoid.length} don'ts, ${r.categories.length} categories. Not yet saved.`,

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

    return { ...object, sources: input.blocks.map((b) => b.key) };
  },
});

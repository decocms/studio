import { z } from "zod";
import {
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_TARGET_KINDS,
  CAMPAIGN_TRIGGERS,
} from "@decocms/shared/blog-campaign";
import { clampText } from "@decocms/shared/report-seo";

/**
 * A model-authored string that is bounded rather than rejected.
 *
 * On a model's output a `.max()` is not a cap, it is a rejection: zod throws the
 * whole object away, and since the overflowing value is usually something copied
 * verbatim from a tool result, every retry throws it away again for the same
 * reason. One product description longer than a number someone guessed has cost
 * this folder an entire catalogue chunk more than once.
 *
 * So the limit guides the writer through its description and clamps on the way
 * in. The emitted JSON Schema is a plain string carrying no `maxLength`, which
 * is what leaves nothing to reject against.
 *
 * `overwrite` and not `transform`: several of these schemas are also a tool's
 * declared `outputSchema`, which an MCP client lists in output mode, where a
 * transform is unrepresentable and throws. `overwrite` keeps the type it was
 * given, so it survives being serialized either way.
 *
 * For an id, a slug or a URL, use a plain `z.string()`: those are copied
 * character for character, and a truncated one is broken rather than shortened.
 */
export function boundedText(max: number) {
  return z.string().overwrite((value) => clampText(value, max));
}

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

/** How long a campaign's free text may run before it is clamped. */
const MAX_CAMPAIGN_TEXT_CHARS = 2_000;

/**
 * What the model writes here is clamped, never rejected.
 *
 * {@link boundedText} explains why at length. The short of it: these fields
 * carry values copied out of a tool result, a `.max()` on them throws away the
 * whole campaign rather than the overlong field, and every retry throws it away
 * again for the same reason. Ids and URLs carry no bound at all — truncating one
 * breaks it.
 */
const TargetSchema = z.object({
  kind: z.enum(CAMPAIGN_TARGET_KINDS),
  id: z
    .string()
    .describe(
      "The store's own id, exactly as a tool reported it. For a collection this IS the identifier, so it is required; for a category it is optional.",
    ),
  name: boundedText(MAX_CAMPAIGN_TEXT_CHARS),
  url: z
    .string()
    .describe(
      "The address a reader can open. Never invented. Always '' for a collection: a collection is a cluster the store filters by, not a page, so it has no address of its own.",
    ),
  description: boundedText(MAX_CAMPAIGN_TEXT_CHARS).describe(
    "What falls inside this slice, and who it is for.",
  ),
});

const ProductSchema = z.object({
  id: z.string(),
  name: boundedText(MAX_CAMPAIGN_TEXT_CHARS),
  url: z.string(),
  images: z
    .array(z.string())
    .describe(
      "Left to the catalogue when the product is in it. Fill this only for a product no catalogue entry covers, copying the URLs a tool reported verbatim — they sit on a CDN whose host is NOT the store's.",
    ),
  category: boundedText(MAX_CAMPAIGN_TEXT_CHARS),
  description: boundedText(MAX_CAMPAIGN_TEXT_CHARS),
});

/** A campaign as proposed — no key, no audit dates; the caller stamps those. */
export const CampaignDraftSchema = z.object({
  name: boundedText(MAX_CAMPAIGN_TEXT_CHARS).describe(
    "What someone would call this campaign. 'Black Friday 2026'.",
  ),
  period: z.object({
    start: z
      .string()
      .nullable()
      .describe("`YYYY-MM-DD`, or null when the moment has no fixed date."),
    end: z.string().nullable(),
  }),
  trigger: z.object({
    type: z.enum(CAMPAIGN_TRIGGERS),
    note: boundedText(MAX_CAMPAIGN_TEXT_CHARS).describe(
      "Why this campaign exists now — what a writer reads first.",
    ),
  }),
  intent: z.object({
    objective: z.enum(CAMPAIGN_OBJECTIVES),
    targets: z.array(TargetSchema),
    products: z.array(ProductSchema),
    keywords: z.array(boundedText(MAX_CAMPAIGN_TEXT_CHARS)),
  }),
  guardrails: z.object({
    avoidComplements: z
      .array(BrandRuleSchema)
      .describe("Added to the brand's guardrails for this campaign only."),
    toneOverrides: boundedText(MAX_CAMPAIGN_TEXT_CHARS).describe(
      "Replaces the brand's tone while this runs. '' to keep it.",
    ),
  }),
});

/** One example sentence, and whether it is one to imitate or one to avoid — a pair of opposites teaches a voice faster than either side alone, since "not like this" is what pins down how far "like this" goes. */
const VoiceExampleSchema = z.object({
  text: z.string().describe("The sentence, exactly as it is written"),
  sounds: z
    .boolean()
    .describe(
      "True when this is how the brand sounds, false when it is a counter-example",
    ),
});

/**
 * What writing one post needs from the brand: who it is, who reads it, how it
 * sounds, which words it uses, what it refuses and how it fills its blocks.
 * The campaign brings the rest: its own keywords, its products, its dates.
 */
export const ReducedContextSchema = z.object({
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
  storeUrl: z
    .string()
    .describe(
      "The storefront's public address, origin only — https://loja.com. What a reader would type. Never an admin, preview or platform host: a `*.vtexcommercestable.com.br` or `*.deco.site` address is internal and does not belong here. Read it from canonical links, absolute links in the content, or the og:url.",
    ),
  targetAudience: z
    .string()
    .describe(
      "Who reads this brand's content and what they came looking for. Infer from who the copy addresses and what it assumes the reader already cares about. Say so plainly rather than reaching for marketing personas.",
    ),
  tone: z
    .string()
    .describe(
      "Tone of voice, described so another writer could reproduce it: how the reader is addressed (which pronoun, which person), sentence length, humor, jargon level, formality, and casing conventions. Read the longest run of real prose you can find — post bodies if they exist, otherwise page copy and meta descriptions.",
    ),
  dos: z
    .array(BrandRuleSchema)
    .describe(
      "Instructions a blogpost writer must follow for this brand, derived from patterns the copy consistently follows. `name` names the rule ('Abertura do post'), `value` is the imperative instruction — instructions, not adjectives: 'Open with the customer's problem, never with the company' beats 'customer-focused'. Any brand-specific word for an ordinary thing gets its own rule, quoted in the brand's language — for a Portuguese site, \"chame a sacola de 'mochila', nunca de 'carrinho'\".",
    ),
  avoid: z
    .array(BrandRuleSchema)
    .describe(
      "Things a blogpost writer must not do — banned words, claims, formats, topics. `name` names the guardrail, `value` states the prohibition and why the copy suggests it. Derive them from what the copy consistently never does and from claims the brand is visibly careful about. Do not restate a `dos` entry inverted.",
    ),
  vocabulary: z
    .array(BrandRuleSchema)
    .describe(
      "The brand's own words, and the ordinary ones they replace. `name` is the word to use, `value` says what it names and which word it displaces — for a Portuguese site, \"mochila: a sacola de compras; nunca 'carrinho'\". Take these verbatim from the copy, in the brand's language. A generated post using the displaced word reads as an impostor, which is the whole reason this field exists.",
    ),
  voiceExamples: z
    .array(VoiceExampleSchema)
    .describe(
      "Sentences that show the voice by example, where a description of it would be argued with. Quote VERBATIM from the site — never paraphrased, never improved — and pick sentences a customer actually reads: never an editor's internal annotation, never a shipping term. At most 6, each earning its place by showing something the others do not. Always `sounds: true`: the counter-examples are a human's judgement call, not yours.",
    ),
  blocks: z
    .array(BrandRuleSchema)
    .describe(
      'How this brand fills each blog block it uses. `name` is the block as a format cites it (\'@Heading\'), `value` its default props — values the block\'s own code accepts, such as `{"level":"h2"}` for a section and `"h3"` for a question inside one — and when to use it. Where it gives a value, that value wins over the block\'s stored example.',
    ),
  commercialPolicies: z
    .array(BrandRuleSchema)
    .describe(
      "Exchange, shipping, warranty and payment terms, as the site states them. `name` is the policy ('Frete grátis'), `value` the terms with their actual numbers and conditions. These are facts a post may need to state correctly, never a source of voice. Copy the numbers exactly; a wrong threshold in a post is a promise the brand did not make.",
    ),
});

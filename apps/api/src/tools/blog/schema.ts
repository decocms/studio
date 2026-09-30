import { z } from "zod";

/**
 * One editorial rule: a short name plus a markdown body. Flat strings could not
 * carry a rule worth writing down ("never print prices in a text block, use
 * ProductCard") nor a competitor worth naming (a name alone says nothing about
 * how the brand differs from it).
 */
export const BrandRuleSchema = z.object({
  name: z
    .string()
    .describe("Short phrase naming the rule — what it is about, not the rule"),
  value: z
    .string()
    .describe(
      "The rule itself, as markdown. One or two paragraphs; use a bullet list only when there are genuinely several cases. No heading — the name is the heading.",
    ),
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
 * Who the brand is, in `blog-manager-brand.json` — facts that hold whether or not it ever blogs.
 */
export const BlogBrandSchema = z.object({
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
  competitors: z
    .array(BrandRuleSchema)
    .describe(
      "Competitors named explicitly in the content. A brand rarely names them in its own copy — return an empty array unless a name is actually there, and never guess from the market segment. When one is named, `name` is the competitor and `value` is what the content says about it.",
    ),
  keywords: z
    .array(BrandRuleSchema)
    .describe(
      "Search terms this brand should be found by: what a customer types when looking for what it sells. `name` is the term, exactly as someone would search it, in the brand'''s language. `value` says who searches it and what they are after — the intent behind the words. Take them from what the site sells and how it names things: product and category terms belong here, and so do the questions its audience asks around them. Not a list of the brand'''s themes, and never the brand'''s own name alone.",
    ),
  differentiators: z
    .array(BrandRuleSchema)
    .describe(
      "What this brand has that a competitor cannot claim — an exclusive process, a material, a service, an origin story with evidence. `name` names it, `value` states the claim and what backs it. A differentiator a rival could copy verbatim into its own site is not one.",
    ),
  commercialPolicies: z
    .array(BrandRuleSchema)
    .describe(
      "Exchange, shipping, warranty and payment terms, as the site states them. `name` is the policy ('Frete grátis'), `value` the terms with their actual numbers and conditions. These are facts a post may need to state correctly, never a source of voice. Copy the numbers exactly; a wrong threshold in a post is a promise the brand did not make.",
    ),
  specialDates: z
    .array(BrandRuleSchema)
    .describe(
      "The commercial moments this brand's calendar turns around — both its own ('Semana Granado') and the general retail dates that matter to its country and segment (Black Friday, Dia das Mães, 8/8). `name` is the date's name, `value` explains what that date means FOR THIS BRAND: what it sells then, what it says then, who it is aimed at. Not a calendar pin — no exact day is wanted, because these move year to year.",
    ),
});

/**
 * How this blog is written: the rules a generated post must follow. Persisted
 * to the site's `blog-manager-context.json`, separately from the brand, because
 * these evolve with the blog while the brand's identity does not.
 *
 * `BLOG_CONTEXT_EXTRACT` produces this.
 */
export const BlogGenerationSchema = z.object({
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
  categories: z
    .array(z.string())
    .describe(
      "Content categories that fit this brand's blog, as plain names — this is a taxonomy, not a rule, so no body. Take existing category blocks first; with no blog, derive them from the themes the site's own pages keep returning to. Editorial subjects, not the product taxonomy.",
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
});

/**
 * The whole editorial context, brand and generation rules together — what a
 * post is actually written from.
 *
 * The two halves are stored and inferred apart, but every tool downstream of
 * the extract needs both, and takes this `.partial()`: a half-filled context is
 * the normal case, since the extract leaves unevidenced fields blank and a
 * human fills the rest. `normalizeBrandRules` (web) reads the older `string[]`
 * rule lists too.
 */
export const BlogContextSchema = BlogBrandSchema.merge(BlogGenerationSchema);

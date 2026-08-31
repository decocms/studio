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

/**
 * Editorial brand context for blogpost generation. Field names match Spire's
 * `blog-manager-brand.json`; `normalizeBrandRules` (web) reads the older
 * `string[]` rule lists too.
 *
 * `BLOG_BRAND_EXTRACT` produces this; every later tool in the pipeline consumes
 * it, and takes it `.partial()` — a half-filled brand block is the normal case,
 * since the extract leaves unevidenced fields blank and a human fills the rest.
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
  competitors: z
    .array(BrandRuleSchema)
    .describe(
      "Competitors named explicitly in the content. A brand rarely names them in its own copy — return an empty array unless a name is actually there, and never guess from the market segment. When one is named, `name` is the competitor and `value` is what the content says about it.",
    ),
});

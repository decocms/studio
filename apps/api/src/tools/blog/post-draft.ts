import { z } from "zod";
import {
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_TRIGGERS,
} from "@decocms/shared/blog-campaign";
import { renderGrounding } from "./site-tools";
import {
  CampaignGoalSchema,
  campaignGoals,
  MAX_CAMPAIGN_GOALS,
} from "@decocms/shared/blog-campaign";
import { ReducedContextSchema } from "./schema";
import { IMAGE_SENTINEL } from "./block-props";

/**
 * One blog post, written from a campaign and shaped by a format.
 *
 * The campaign is what the post is for — a moment, a shelf of products, a slice
 * of the catalogue, a tone the brand takes while it runs. The format is how
 * this brand builds a post of that kind, and the blocks it cites come first.
 *
 * The blocks arrive with their own JSON Schema, which is the whole point: a
 * site that overrides a section with different props used to get the props this
 * file assumed, and a block that saves fine and renders empty is the worst way
 * to be wrong.
 */

const MAX_NAME_CHARS = 200;
const MAX_BODY_CHARS = 8_000;
const MAX_SECTIONS = 40;
const MAX_CATEGORIES = 100;
const MAX_AUTHORS = 100;
const MAX_BLOCKS = 40;
const MAX_SCHEMA_CHARS = 8_000;
const MAX_PRODUCTS = 40;
const MAX_TARGETS = 20;

/**
 * One block this post may use, as the writer sees it.
 *
 * `schema` is the site's own, resolved — never a name this file knows the shape
 * of. The resolveType deliberately does not travel: the caller maps the name
 * back, so the model cannot invent one.
 */
const BlockSchema = z.object({
  name: z.string().max(MAX_NAME_CHARS),
  title: z.string().max(MAX_NAME_CHARS),
  description: z.string().max(MAX_BODY_CHARS),
  schema: z
    .record(z.string(), z.unknown())
    .describe("The block's JSON Schema. Its props are exactly these."),
  example: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "One of this block as the site already stores it. Where it disagrees with the schema, it is the one that renders.",
    ),
});

const CampaignSchema = z.object({
  name: z.string().max(MAX_NAME_CHARS),
  period: z.object({
    start: z.string().max(MAX_NAME_CHARS).nullable(),
    end: z.string().max(MAX_NAME_CHARS).nullable(),
  }),
  trigger: z.object({
    type: z.enum(CAMPAIGN_TRIGGERS),
    note: z.string().max(MAX_BODY_CHARS),
  }),
  goals: z.array(CampaignGoalSchema).max(MAX_CAMPAIGN_GOALS).optional(),
  goal: CampaignGoalSchema.optional(),
  intent: z.object({
    objective: z.enum(CAMPAIGN_OBJECTIVES),
    targets: z
      .array(
        z.object({
          kind: z.string().max(MAX_NAME_CHARS),
          name: z.string().max(MAX_NAME_CHARS),
          url: z.string().max(MAX_BODY_CHARS),
          description: z.string().max(MAX_BODY_CHARS),
        }),
      )
      .max(MAX_TARGETS)
      .default([]),
    products: z
      .array(
        z.object({
          id: z
            .string()
            .max(MAX_NAME_CHARS)
            .describe("What a product block points at this product with."),
          name: z.string().max(MAX_NAME_CHARS),
          url: z.string().max(MAX_BODY_CHARS),
          images: z.array(z.string().max(MAX_BODY_CHARS)).default([]),
          category: z.string().max(MAX_NAME_CHARS),
          description: z.string().max(MAX_BODY_CHARS),
        }),
      )
      .max(MAX_PRODUCTS)
      .default([]),
    keywords: z.array(z.string().max(MAX_NAME_CHARS)).default([]),
  }),
  guardrails: z.object({
    avoidComplements: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .default([]),
    toneOverrides: z.string().max(MAX_BODY_CHARS).default(""),
  }),
});

const SYSTEM = `You write one blog post for a brand, from a campaign (what the post is for) and a format (how this brand builds a post of that kind).

WRITE THE WHOLE POST IN THE BRAND'S OWN LANGUAGE — the one reported as \`language\` in its profile. These instructions are in English because they are instructions; the post is content, and content follows the brand.

THE BRAND PROFILE IS BINDING, NOT BACKGROUND. Its \`tone\` says how to sound, and you reproduce it rather than approximating it — pronoun, sentence length, formality, casing. Its \`dos\` are instructions you follow. Its \`avoid\` entries are prohibitions: a post that breaks one is a failure however well written. Where the brand renames an ordinary thing, use the brand's word.

THE CAMPAIGN IS THE BRIEF, THE FORMAT IS THE SHAPE. The campaign says why this post exists now — the moment, the objective, the slice of the catalogue it argues for and the products it may name. Write into that. The format describes how a post like this opens, develops and closes, and cites blocks as \`@Name\`; treat those citations as what this brand reaches for, not as a fixed running order. You choose the sequence and how many of each.

THE BLOCKS ARE TYPED, AND THE TYPE IS BINDING. Each available block comes with its JSON Schema. \`props\` is a JSON object matching THAT schema — its property names, its types, its enums, everything it marks required. A prop the schema does not declare is dropped. A value the schema rejects loses the entire section, not just that prop. Read the schema before you write the section: a field called \`items\` that is typed as a string is one string, not a list, however much it sounds like a list.

COPY THE EXAMPLE'S SHAPE. A block that shows one is showing you how this site actually stores it — and a prop the schema leaves untyped is one a stored block already disproved, so the example is the only account of it you have. Follow it: same property names, same shape, your own content.

USE ONLY THE BLOCKS YOU ARE GIVEN, by the \`name\` given. A block that is not listed does not exist on this site.

THE CAMPAIGN'S PRODUCTS ARE THE ONLY PRODUCTS. Name them with the names given, link them with the links given, and use their image addresses exactly as written — those sit on a CDN and rebuilding one produces an image that silently fails to load. Never name a product the campaign did not give you.

A PRODUCT SLOT IS NOT YOURS TO WRITE. A block that shows products has a prop for them — \`product\` or \`products\` — and you leave it OUT of \`props\` entirely. Put the campaign products' \`id\` values in \`productIds\` instead, in the order they should appear, and the slot is filled for you in whatever shape this site stores. Only ids the campaign listed; never one taken from a block's example, because that example points at a real product and a different one.

IMAGES YOU WANT MADE. Where a block prop takes an image address and the picture does not exist yet, write \`${IMAGE_SENTINEL}\` followed by what the image should show — \`${IMAGE_SENTINEL}a woman closing a hard-shell suitcase on a hotel bed, morning light\` — and the illustrator draws it after you. Use this at most twice in a post, and only where the format's blocks ask for an image. Never write it into a prop that holds prose — it is an image address, not a sentence. For a product's own photograph, copy the campaign's address instead: a generated picture of a product the brand sells is a picture of something else.

WRITE SOMETHING WORTH READING. Open on the reader's problem or curiosity, never on the company. Make every section carry a specific claim, an example or a number rather than restating the heading. Vary section length. Close with one clear next step.

NEVER INVENT A VERIFIABLE FACT. No statistics, prices, dates, product names, awards or quotes from real people unless they came from the brand profile, the campaign, or what the store reported. Say less rather than fabricate: a human reviews this and can add a number, but cannot tell which of your numbers you made up.

The excerpt is what a reader sees in a list — a sentence that earns the click, not the first line of the post repeated. The SEO title and description are for search results: the title carries the searched phrase and stays under about 60 characters, the description states the payoff in under about 155.

FILE AND ATTRIBUTE THE POST. Pick the categories it belongs in and the author it most sounds like, from the lists you are given — usually one of each. Choose only from those lists: anything else is dropped, and the post lands unfiled or unattributed. Given an empty list, return an empty list.`;

function renderRules(
  label: string,
  rules: { name: string; value: string }[] | undefined,
): string | null {
  if (!rules?.length) return null;
  return `## ${label}\n${rules
    .map((r) => `- ${r.name}${r.value ? `: ${r.value}` : ""}`)
    .join("\n")}`;
}

/**
 * Example sentences as two lists. Splitting them is the whole value: a model
 * handed a flat list of sentences imitates all of them, including the ones
 * marked as what the brand never sounds like.
 */
function renderVoiceExamples(
  examples: { text: string; sounds: boolean }[] | undefined,
): string | null {
  const written = (examples ?? []).filter((example) => example.text.trim());
  if (written.length === 0) return null;
  const render = (sounds: boolean) =>
    written
      .filter((example) => example.sounds === sounds)
      .map((example) => `- "${example.text.trim()}"`)
      .join("\n");
  const like = render(true);
  const unlike = render(false);
  return [
    like &&
      `## Sounds like this brand — match the register, never copy them\n${like}`,
    unlike &&
      `## Does NOT sound like this brand — never write like this\n${unlike}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The campaign as the writer reads it — the brief, not a record dump. */
export function renderCampaign(
  campaign: z.infer<typeof CampaignSchema>,
): string {
  const { intent, period, trigger, guardrails } = campaign;
  const when =
    period.start || period.end
      ? `\nRuns ${period.start ?? "from whenever"} to ${period.end ?? "no fixed end"}.`
      : "";
  const goals = campaignGoals(campaign).map((goal) => {
    const measure = [goal.target.trim(), goal.metric?.replaceAll("_", " ")]
      .filter(Boolean)
      .join(" ");
    return `${goal.text.trim()}${measure ? ` (${measure})` : ""}`;
  });
  const aim =
    goals.length > 0
      ? `\nGoals: ${goals.join("; ")}. Every post in this campaign is a step toward them.`
      : "";
  return [
    `## The campaign: ${campaign.name}\nWhy now (${trigger.type}): ${trigger.note}\nObjective: ${intent.objective}.${aim}${when}`,
    intent.targets.length > 0 &&
      `## What it argues for\n${intent.targets
        .map(
          (t) =>
            `- ${t.name} (${t.kind})${t.url ? ` — ${t.url}` : ""}${t.description ? `\n  ${t.description}` : ""}`,
        )
        .join("\n")}`,
    intent.products.length > 0 &&
      `## Products this post may name\nUse these names, these links and these image addresses, exactly. The \`id\` is what a product block points at.\n${intent.products
        .map(
          (p) =>
            `- ${p.name}${p.category ? ` — ${p.category}` : ""}${p.id ? `\n  id: ${p.id}` : ""}${p.url ? `\n  link: ${p.url}` : ""}${p.images.length > 0 ? `\n  images: ${p.images.join(", ")}` : ""}${p.description ? `\n  ${p.description}` : ""}`,
        )
        .join("\n")}`,
    intent.keywords.length > 0 &&
      `## Terms this post should be found by\n${intent.keywords.map((k) => `- ${k}`).join("\n")}`,
    renderRules(
      "Guardrails for this campaign only — on top of the brand's",
      guardrails.avoidComplements,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A block, with its schema and a real one of it, as one prompt section. */
function renderBlock(block: z.infer<typeof BlockSchema>): string {
  const schema = JSON.stringify(block.schema).slice(0, MAX_SCHEMA_CHARS);
  const example = block.example
    ? `\nAs this site stores it:\n\`\`\`json\n${JSON.stringify(block.example)}\n\`\`\``
    : "";
  return `### ${block.name} — ${block.title}\n${block.description}\n\`\`\`json\n${schema}\n\`\`\`${example}`;
}

/** What writing a post reads: the brand, the campaign, the format and the site's blocks. */
export const WritingInputSchema = z.object({
  brand: ReducedContextSchema.partial().describe(
    "What writing needs: who the brand is, who reads it, how it sounds, its words and its guardrails. companyName, language, description, tone, targetAudience, dos and avoid are all required — a post written without them is generic.",
  ),
  campaign: CampaignSchema.describe(
    "The campaign this post is written for — the brief, the products and the campaign-only guardrails.",
  ),
  format: z
    .object({
      name: z.string().max(MAX_NAME_CHARS),
      value: z.string().max(MAX_BODY_CHARS),
    })
    .describe("How this brand builds a post of this kind."),
  blocks: z
    .array(BlockSchema)
    .min(1)
    .max(MAX_BLOCKS)
    .describe(
      "The only blocks this post may be built from, each with the schema its props must match.",
    ),
  categories: z
    .array(
      z.object({
        name: z.string().max(MAX_NAME_CHARS),
        slug: z.string().max(MAX_NAME_CHARS),
      }),
    )
    .max(MAX_CATEGORIES)
    .default([])
    .describe("The blog's categories, to file these posts under."),
  authors: z
    .array(
      z.object({
        name: z.string().max(MAX_NAME_CHARS),
        email: z.string().max(MAX_NAME_CHARS),
        bio: z.string().max(MAX_BODY_CHARS).optional(),
      }),
    )
    .max(MAX_AUTHORS)
    .default([])
    .describe("The blog's authors, to attribute these posts to."),
  extraInstructions: z
    .string()
    .max(MAX_BODY_CHARS)
    .optional()
    .describe(
      "What the operator asked for on top of everything else, in their own words.",
    ),
});

type WritingInput = z.infer<typeof WritingInputSchema>;

/** Refuses a brand a post would read generic from, naming what to fill. */
function requireEditorialBrand(brand: WritingInput["brand"]): void {
  const missing = [
    !brand.companyName?.trim() && "companyName",
    !brand.language?.trim() && "language",
    !brand.description?.trim() && "description",
    !brand.tone?.trim() && "tone",
    !brand.targetAudience?.trim() && "targetAudience",
    !brand.dos?.length && "dos",
    !brand.avoid?.length && "avoid",
  ].filter((field): field is string => typeof field === "string");
  if (missing.length > 0) {
    throw new Error(
      `Editorial brand context is incomplete — fill ${missing.join(", ")} before generating. A post written without it reads like any other brand's.`,
    );
  }
}

/** Everything a writer reads about this post, in the order it reads it. */
function writingContext(input: WritingInput, grounding: string): string {
  const { brand, campaign } = input;
  const tone = campaign.guardrails.toneOverrides.trim() || brand.tone;
  return [
    `## Brand\n${brand.companyName}`,
    `## What it does\n${brand.description}`,
    `## Language to write in\n${brand.language}`,
    brand.storeUrl && `## The store's address\n${brand.storeUrl}`,
    `## Tone of voice\n${tone}`,
    `## Audience\n${brand.targetAudience}`,
    renderRules("Editorial instructions — follow these", brand.dos),
    renderRules("Guardrails — never do these", brand.avoid),
    renderRules(
      "The brand's own words — use these, not the words they displace",
      brand.vocabulary,
    ),
    renderVoiceExamples(brand.voiceExamples),
    renderCampaign(campaign),
    `## Format: ${input.format.name}\n${input.format.value}`,
    `## Blocks available — props must match these schemas\n\n${input.blocks
      .map(renderBlock)
      .join("\n\n")}`,
    input.categories.length > 0 &&
      `## Categories\n${input.categories.map((c) => `- ${c.name} (${c.slug})`).join("\n")}`,
    input.authors.length > 0 &&
      `## Authors\n${input.authors
        .map((a) => `- ${a.name} (${a.email})${a.bio ? ` — ${a.bio}` : ""}`)
        .join("\n")}`,
    input.extraInstructions &&
      `## What the operator asked for\n${input.extraInstructions}`,
    renderGrounding(grounding),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The shape an agent answers in: the draft's, with `props` as an object. */
const AGENT_TASK = `## Your task
Write the post, and answer with one JSON object in this shape:

\`\`\`json
{
  "title": "the headline",
  "excerpt": "one sentence that earns the click",
  "seo": { "title": "~60 characters", "description": "~155 characters" },
  "cover": {
    "prompt": "what the cover shows, as a photographic brief: subject, setting, light, mood. No text, logos or brand name in the image",
    "alt": "the cover's alt text"
  },
  "categorySlugs": ["chosen from the categories"],
  "authorEmails": ["chosen from the authors"],
  "sections": [
    { "type": "a block's name", "props": { "…": "matching that block's schema" }, "productIds": [] }
  ]
}
\`\`\`

\`props\` is an object here, not a string. \`productIds\` holds campaign product ids for a product block and stays empty for every other. At most ${MAX_SECTIONS} sections.`;

/**
 * The brief for the agent that writes the post: the rules it writes under,
 * its reading of the brand, campaign and blocks, and the shape to answer in.
 */
export function agentWritingBrief(
  input: WritingInput,
  grounding: string,
): string {
  requireEditorialBrand(input.brand);
  return [SYSTEM, writingContext(input, grounding), AGENT_TASK].join("\n\n");
}

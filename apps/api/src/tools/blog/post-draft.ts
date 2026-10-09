import { retryGenerateObject } from "./generate-object";
import { z } from "zod";
import {
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_TRIGGERS,
} from "@decocms/shared/blog-campaign";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import {
  groundSiteReport,
  renderGrounding,
  VirtualMcpIdSchema,
} from "./site-tools";
import { resolveTier } from "../../core/resolve-tier";
import { ReducedContextSchema } from "./schema";
import {
  clearUnfilled,
  IMAGE_SENTINEL,
  imageRequests,
  readProps,
  withImageAt,
} from "./block-props";
import { painterFor } from "./cover-image";

/**
 * One blog post, written from a campaign and shaped by a format.
 *
 * The campaign is what the post is for — a moment, a shelf of products, a slice
 * of the catalogue, a tone the brand takes while it runs. The format is how
 * this brand builds a post of that kind, and the blocks it cites are the only
 * ones this post may be made of.
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

/** Posts one request may write. Beyond this nobody reads them all anyway. */
const MAX_DRAFTS = 3;

/** Images in the body of one post, over and above its cover. */
const MAX_BODY_IMAGES = 2;

const GROUNDING_TIMEOUT_MS = 120_000;
const GROUNDING_MAX_STEPS = 12;

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

/**
 * One section of the post body.
 *
 * `props` is a JSON string rather than an object: a schema the model fills
 * freely becomes `additionalProperties` in structured output, which is the kind
 * of thing that works on three providers and fails on the fourth. The caller
 * validates against the block's real schema either way, so nothing is lost by
 * going through a string.
 */
const SectionSchema = z.object({
  type: z
    .string()
    .describe("The block's `name`, exactly as given in the available blocks."),
  props: z
    .string()
    .describe(
      "A JSON object matching that block's schema. Only props the schema declares; anything else is dropped, and a value the schema rejects loses the whole section.",
    ),
});

const PostSchema = z.object({
  title: z
    .string()
    .describe("The post's headline, in the brand's voice and language"),
  excerpt: z.string().describe("One sentence that earns the click"),
  seo: z.object({
    title: z.string().describe("Search-result title, ~60 characters"),
    description: z.string().describe("Search-result description, ~155"),
  }),
  cover: z.object({
    prompt: z
      .string()
      .describe(
        "What the cover image shows, as a photographic brief: subject, setting, light, mood. No text in the image, no logos, no brand name — a model renders lettering badly and a cover with words in it cannot be reused.",
      ),
    alt: z
      .string()
      .describe("The alt text for that image, in the brand's language."),
  }),
  categorySlugs: z
    .array(z.string())
    .describe("Slugs chosen from the given categories — usually one"),
  authorEmails: z
    .array(z.string())
    .describe("Emails chosen from the given authors — usually one"),
  sections: z
    .array(SectionSchema)
    .max(MAX_SECTIONS)
    .describe("The post body, in reading order"),
});

const GAP_CODES = [
  "no-store-data",
  "sections-dropped",
  "no-bucket",
  "no-image-model",
  "images-failed",
  "drafts-failed",
] as const;

const GapSchema = z.object({
  code: z.enum(GAP_CODES),
  count: z.number().int().optional(),
});
export type Gap = z.infer<typeof GapSchema>;

const SYSTEM = `You write one blog post for a brand, from a campaign (what the post is for) and a format (how this brand builds a post of that kind).

WRITE THE WHOLE POST IN THE BRAND'S OWN LANGUAGE — the one reported as \`language\` in its profile. These instructions are in English because they are instructions; the post is content, and content follows the brand.

THE BRAND PROFILE IS BINDING, NOT BACKGROUND. Its \`tone\` says how to sound, and you reproduce it rather than approximating it — pronoun, sentence length, formality, casing. Its \`dos\` are instructions you follow. Its \`avoid\` entries are prohibitions: a post that breaks one is a failure however well written. Where the brand renames an ordinary thing, use the brand's word.

THE CAMPAIGN IS THE BRIEF, THE FORMAT IS THE SHAPE. The campaign says why this post exists now — the moment, the objective, the slice of the catalogue it argues for and the products it may name. Write into that. The format describes how a post like this opens, develops and closes, and cites blocks as \`@Name\`; treat those citations as what this brand reaches for, not as a fixed running order. You choose the sequence and how many of each.

THE BLOCKS ARE TYPED, AND THE TYPE IS BINDING. Each available block comes with its JSON Schema. \`props\` is a JSON object matching THAT schema — its property names, its types, its enums, everything it marks required. A prop the schema does not declare is dropped. A value the schema rejects loses the entire section, not just that prop. Read the schema before you write the section: a field called \`items\` that is typed as a string is one string, not a list, however much it sounds like a list.

COPY THE EXAMPLE'S SHAPE. A block that shows one is showing you how this site actually stores it — and a prop the schema leaves untyped is one a stored block already disproved, so the example is the only account of it you have. Follow it: same property names, same shape, your own content.

USE ONLY THE BLOCKS YOU ARE GIVEN, by the \`name\` given. A block that is not listed does not exist on this site.

THE CAMPAIGN'S PRODUCTS ARE THE ONLY PRODUCTS. Name them with the names given, link them with the links given, and use their image addresses exactly as written — those sit on a CDN and rebuilding one produces an image that silently fails to load. Never name a product the campaign did not give you.

A LOADER-DRIVEN FIELD TAKES A REFERENCE, AND ONLY ONE YOU WERE GIVEN. A prop whose schema says \`"format": "dynamic-options"\` holds a handle a loader resolves against the live catalogue, not a product. Each campaign product lists its \`reference\` — use that, exactly, and nothing else. NEVER copy the value out of a block's example: that example points at a real product, a different one, and a card showing the wrong product is worse than a card showing none. With no reference for a product, leave the field empty — an empty shelf is one someone fills in two clicks.

IMAGES YOU WANT MADE. A block prop whose schema says \`"format": "image-uri"\` takes an image address. For an image that does not exist yet, write \`${IMAGE_SENTINEL}\` followed by what the image should show — \`${IMAGE_SENTINEL}a woman closing a hard-shell suitcase on a hotel bed, morning light\` — and it is generated and uploaded for you. Use this at most twice in a post, and only where the format's blocks ask for an image. For a product's own photograph, copy the campaign's address instead: a generated picture of a product the brand sells is a picture of something else.

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

/**
 * The handle a block uses to point at one of the campaign's products.
 *
 * A product field on a section is resolved by a loader, so it holds a
 * reference rather than a product — and the campaign carries no id a loader
 * would accept: what the catalogue reported is a stock code, not the id the
 * storefront indexes by. The product's own address is the one handle that is
 * both ours and unambiguous, so its slug is what travels.
 *
 * Derived here rather than asked for: composing a slug is the kind of thing a
 * model does plausibly and wrongly, and this one is a substring.
 */
export function productReference(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    const segments = path.split("/").filter(Boolean);
    const last = segments.at(-1);
    // A VTEX product page is `/<slug>/p`; the slug is what identifies it.
    const slug = last === "p" ? segments.at(-2) : last;
    return slug ?? "";
  } catch {
    return "";
  }
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
  return [
    `## The campaign: ${campaign.name}\nWhy now (${trigger.type}): ${trigger.note}\nObjective: ${intent.objective}.${when}`,
    intent.targets.length > 0 &&
      `## What it argues for\n${intent.targets
        .map(
          (t) =>
            `- ${t.name} (${t.kind})${t.url ? ` — ${t.url}` : ""}${t.description ? `\n  ${t.description}` : ""}`,
        )
        .join("\n")}`,
    intent.products.length > 0 &&
      `## Products this post may name\nUse these names, these links, these image addresses and these references, exactly.\n${intent.products
        .map((p) => {
          const reference = productReference(p.url);
          return `- ${p.name}${p.category ? ` — ${p.category}` : ""}${p.url ? `\n  link: ${p.url}` : ""}${reference ? `\n  reference: ${reference}` : ""}${p.images.length > 0 ? `\n  images: ${p.images.join(", ")}` : ""}${p.description ? `\n  ${p.description}` : ""}`;
        })
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

/**
 * A block's props as one log line.
 *
 * What a site publishes for its own sections is the one thing this tool cannot
 * see from here, and two rounds of "why did that section come out wrong" went
 * to guessing for want of it. Names, types and widgets only — the descriptions
 * are the bulk and say nothing about shape.
 */
function describeBlock(block: z.infer<typeof BlockSchema>): string {
  const properties = block.schema.properties;
  if (!properties || typeof properties !== "object") {
    return `${block.name}: no schema`;
  }
  const props = Object.entries(properties as Record<string, unknown>).map(
    ([name, raw]) => {
      const prop = (raw ?? {}) as Record<string, unknown>;
      const enumValues = Array.isArray(prop.enum)
        ? `(${prop.enum.join("|")})`
        : "";
      const widget = prop.format ? `:${prop.format}` : "";
      return `${name}=${prop.type}${enumValues}${widget}`;
    },
  );
  return `${block.name}: ${props.join(" ")}${block.example ? " +example" : ""}`;
}

/** A block, with its schema and a real one of it, as one prompt section. */
function renderBlock(block: z.infer<typeof BlockSchema>): string {
  const schema = JSON.stringify(block.schema).slice(0, MAX_SCHEMA_CHARS);
  const example = block.example
    ? `\nAs this site stores it:\n\`\`\`json\n${JSON.stringify(block.example)}\n\`\`\``
    : "";
  return `### ${block.name} — ${block.title}\n${block.description}\n\`\`\`json\n${schema}\n\`\`\`${example}`;
}

export const BLOG_POST_DRAFT = defineTool({
  name: "BLOG_POST_DRAFT",
  description:
    "Write blog posts for a campaign, shaped by one of the brand's formats and built only from blocks the site actually renders, each validated against its own schema. Generates a cover image and uploads it to the organization's bucket. Returns up to `count` drafts; does not persist — the caller builds the blocks and schedules them.",
  annotations: {
    title: "Draft a Blog Post",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
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
    count: z
      .number()
      .int()
      .min(1)
      .max(MAX_DRAFTS)
      .default(1)
      .describe("How many drafts to write. Each is a separate angle."),
    fileConfigId: z
      .string()
      .max(256)
      .optional()
      .describe(
        "The organization's bucket, where a generated image is uploaded so a reader can load it. Omit and no image is made.",
      ),
    virtualMcpId: VirtualMcpIdSchema,
  }),

  outputSchema: z.object({
    posts: z.array(
      PostSchema.omit({ cover: true, sections: true }).extend({
        cover: z.object({ url: z.string(), alt: z.string() }),
        sections: z.array(
          z.object({
            /** The block's name; the caller maps it to a resolveType. */
            type: z.string(),
            props: z.record(z.string(), z.unknown()),
          }),
        ),
      }),
    ),
    /** What could not be done, as codes the caller words in its own locale. */
    gaps: z.array(GapSchema),
  }),

  /** Token spend, and a spent envelope has to stop it. */
  requiresAiBudget: true,

  modelSummary: (r) =>
    `${r.posts.length} draft(s): ${r.posts
      .map((p) => `"${p.title}" (${p.sections.length} section(s))`)
      .join("; ")}. Not yet saved.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const { brand, campaign } = input;
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

    const tier = await resolveTier(ctx, "thinking");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organizationId,
    );
    const model = provider.aiSdk.languageModel(tier.modelId);

    // One pass for every draft: the store answers the same for all of them.
    const report = await groundSiteReport(ctx, organizationId, {
      virtualMcpId: input.virtualMcpId,
      language: brand.language,
      label: "BLOG_POST_DRAFT",
      maxSteps: GROUNDING_MAX_STEPS,
      timeoutMs: GROUNDING_TIMEOUT_MS,
      task: `Writing ${input.count} blog post(s) for ${brand.companyName}, for the campaign "${campaign.name}": ${campaign.trigger.note}`,
      wanted:
        "Anything these posts would otherwise have to assume: the products they will mention, their real names and current prices, what is in stock, any promotion running now, and what readers of this subject actually search for. Exact figures matter — they are going into copy a customer will hold the brand to.",
    });

    console.info(
      `[BLOG_POST_DRAFT] ${input.blocks.length} block(s) offered`,
      input.blocks.map(describeBlock),
    );

    const tone = campaign.guardrails.toneOverrides.trim() || brand.tone;
    const basePrompt = [
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
      renderGrounding(report.grounding),
    ]
      .filter(Boolean)
      .join("\n\n");

    const written = await Promise.allSettled(
      Array.from({ length: input.count }, (_, i) =>
        retryGenerateObject({
          model,
          schema: PostSchema,
          system: SYSTEM,
          prompt: `${basePrompt}\n\n${task(i, input.count)}`,
        }).then((result) => result.object),
      ),
    );
    const drafts = written.flatMap((draft) =>
      draft.status === "fulfilled" ? [draft.value] : [],
    );
    for (const draft of written) {
      if (draft.status === "rejected") {
        console.warn("[BLOG_POST_DRAFT] one draft failed", draft.reason);
      }
    }

    const painter = await painterFor(
      ctx,
      organizationId,
      input.fileConfigId,
      "BLOG_POST_DRAFT",
    );
    const byName = new Map(input.blocks.map((block) => [block.name, block]));
    let droppedSections = 0;
    const dropped = new Map<string, number>();

    const posts = await Promise.all(
      drafts.map(async (draft) => {
        const sections: { type: string; props: Record<string, unknown> }[] = [];
        for (const section of draft.sections.slice(0, MAX_SECTIONS)) {
          const block = byName.get(section.type);
          if (!block) {
            droppedSections += 1;
            note(dropped, `${section.type}: not a block this site has`);
            continue;
          }
          const read = readProps(section.props, block.schema);
          if (!read.props) {
            droppedSections += 1;
            note(dropped, `${section.type}: ${read.reason}`);
            continue;
          }
          sections.push({ type: section.type, props: read.props });
        }

        const [cover, filled] = await Promise.all([
          painter.paint(
            coverPrompt(draft, brand.companyName ?? ""),
            draft.cover.alt,
          ),
          fillBodyImages(sections, byName, painter),
        ]);

        return {
          title: draft.title,
          excerpt: draft.excerpt,
          seo: draft.seo,
          cover: { url: cover, alt: draft.cover.alt },
          categorySlugs: draft.categorySlugs.filter((slug) =>
            input.categories.some((c) => c.slug === slug),
          ),
          authorEmails: draft.authorEmails.filter((email) =>
            input.authors.some((a) => a.email === email),
          ),
          sections: filled,
        };
      }),
    );

    console.info(
      `[BLOG_POST_DRAFT] ${posts.length}/${input.count} draft(s), ${posts.reduce((n, p) => n + p.sections.length, 0)} section(s) kept, ${droppedSections} dropped, images ${painter.outcome()}`,
      [...dropped].map(([reason, n]) => `${n}x ${reason}`),
    );

    return {
      posts,
      gaps: describeGaps({
        grounded: report.outcome === "ok" && report.grounding.trim().length > 0,
        droppedSections,
        failedDrafts: input.count - posts.length,
        images: painter.outcome(),
        covered: posts.filter((post) => post.cover.url).length,
      }),
    };
  },
});

/** Tally one reason a section was dropped, so the log groups rather than floods. */
function note(seen: Map<string, number>, reason: string): void {
  seen.set(reason, (seen.get(reason) ?? 0) + 1);
}

/** What separates one draft from the next, when several are asked for. */
function task(index: number, count: number): string {
  if (count === 1) return "## Your task\nWrite the post.";
  return `## Your task\nWrite the post. This is draft ${index + 1} of ${count}: take an angle on this campaign that the others would not — a different reader, a different question, a different part of the catalogue. Do not hedge toward the middle.`;
}

function coverPrompt(
  draft: z.infer<typeof PostSchema>,
  companyName: string,
): string {
  return `Editorial photograph for a blog post titled "${draft.title}" published by ${companyName}. ${draft.cover.prompt} No text, no lettering, no logo, no watermark anywhere in the image.`;
}

/**
 * The sentinels a draft left behind, turned into addresses.
 *
 * Capped per post rather than per section, so a format citing five image blocks
 * costs what two cost. What is left over is blanked: shipping the sentinel
 * itself would render a broken image on a published page.
 */
async function fillBodyImages(
  sections: { type: string; props: Record<string, unknown> }[],
  byName: Map<string, { schema: Record<string, unknown> }>,
  painter: { paint: (prompt: string, alt: string) => Promise<string> },
): Promise<{ type: string; props: Record<string, unknown> }[]> {
  let budget = MAX_BODY_IMAGES;
  const filled: { type: string; props: Record<string, unknown> }[] = [];
  for (const section of sections) {
    const schema = byName.get(section.type)?.schema;
    if (!schema) {
      filled.push(section);
      continue;
    }
    let props = section.props;
    for (const request of imageRequests(props, schema)) {
      if (budget <= 0) break;
      budget -= 1;
      const url = await painter.paint(request.prompt, request.prompt);
      if (url) props = withImageAt(props, request.path, url);
    }
    filled.push({ type: section.type, props: clearUnfilled(props, schema) });
  }
  return filled;
}

/**
 * What the person is told could not be done.
 *
 * Codes rather than sentences: this runs with no notion of who is reading, and
 * a sentence composed here arrives in English inside an interface someone set
 * to their own language.
 */
export function describeGaps(run: {
  grounded: boolean;
  droppedSections: number;
  failedDrafts: number;
  images: "ok" | "no-bucket" | "no-model" | "failed";
  covered: number;
}): Gap[] {
  const gaps: Gap[] = [];
  if (!run.grounded) gaps.push({ code: "no-store-data" });
  if (run.failedDrafts > 0) {
    gaps.push({ code: "drafts-failed", count: run.failedDrafts });
  }
  if (run.droppedSections > 0) {
    gaps.push({ code: "sections-dropped", count: run.droppedSections });
  }
  if (run.images === "no-bucket") gaps.push({ code: "no-bucket" });
  if (run.images === "no-model") gaps.push({ code: "no-image-model" });
  if (run.images === "failed" && run.covered === 0) {
    gaps.push({ code: "images-failed" });
  }
  return gaps;
}

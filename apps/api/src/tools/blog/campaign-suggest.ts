import { retryGenerateObject } from "./generate-object";
import { z } from "zod";
import {
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_TARGET_KINDS,
  CAMPAIGN_TRIGGERS,
  MAX_CAMPAIGN_PRODUCT_IMAGES,
} from "@decocms/shared/blog-campaign";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import {
  type Catalogue,
  extractCatalogue,
  type GroundingOutcome,
  groundSiteReport,
  renderGrounding,
  VirtualMcpIdSchema,
} from "./site-tools";
import { resolveTier } from "../../core/resolve-tier";
import { BlogContextSchema, BrandRuleSchema } from "./schema";
import type { StudioContext } from "../../core/studio-context";

/**
 * A campaign is a temporary content pillar — a moment the brand writes into and
 * eventually comes back to. Filling one in by hand means knowing things that
 * live in the brand's systems rather than in anyone's head: what sells, what is
 * stuck, what people search for and do not find.
 *
 * So this tool starts from a seed — some keywords and a sentence — and reaches
 * the site's own connections to discover the rest. Without connections it still
 * answers, and says what it could not check.
 */

/** Caps on what a client may send — the request body is a trust boundary. */
const MAX_PROMPT_CHARS = 4_000;
const MAX_KEYWORDS = 50;
const MAX_EXISTING_NAMES = 100;
const MAX_TEXT_CHARS = 2_000;

/** How much of the catalogue one prompt carries. A context is still a context. */
const MAX_CATALOGUE_IN_PROMPT = 80;

/**
 * Reading analytics *and* a catalogue is deeper than reading one site.
 *
 * Generous because the pass no longer loses its work when it runs long: it
 * stops gathering with time to spare and writes up what came back. The cost of
 * a bigger number is someone waiting, not someone getting nothing.
 */
const GROUNDING_MAX_STEPS = 14;
const GROUNDING_TIMEOUT_MS = 120_000;

const TargetSchema = z.object({
  kind: z.enum(CAMPAIGN_TARGET_KINDS),
  id: z
    .string()
    .max(MAX_TEXT_CHARS)
    .describe(
      "The store's own id, exactly as a tool reported it. For a collection this IS the identifier, so it is required; for a category it is optional.",
    ),
  name: z.string().max(MAX_TEXT_CHARS),
  url: z
    .string()
    .max(MAX_TEXT_CHARS)
    .describe(
      "The address a reader can open. Never invented. Always '' for a collection: a collection is a cluster the store filters by, not a page, so it has no address of its own.",
    ),
  description: z
    .string()
    .max(MAX_TEXT_CHARS)
    .describe("What falls inside this slice, and who it is for."),
});

const ProductSchema = z.object({
  id: z.string().max(MAX_TEXT_CHARS),
  name: z.string().max(MAX_TEXT_CHARS),
  url: z.string().max(MAX_TEXT_CHARS),
  images: z
    .array(z.string().max(MAX_TEXT_CHARS))
    .describe(
      "Left to the catalogue when the product is in it. Fill this only for a product no catalogue entry covers, copying the URLs a tool reported verbatim — they sit on a CDN whose host is NOT the store's.",
    ),
  category: z.string().max(MAX_TEXT_CHARS),
  description: z.string().max(MAX_TEXT_CHARS),
});

/** A campaign as proposed — no key, no audit dates; the caller stamps those. */
const CampaignDraftSchema = z.object({
  name: z
    .string()
    .max(MAX_TEXT_CHARS)
    .describe("What someone would call this campaign. 'Black Friday 2026'."),
  period: z.object({
    start: z
      .string()
      .nullable()
      .describe("`YYYY-MM-DD`, or null when the moment has no fixed date."),
    end: z.string().nullable(),
  }),
  trigger: z.object({
    type: z.enum(CAMPAIGN_TRIGGERS),
    note: z
      .string()
      .max(MAX_TEXT_CHARS)
      .describe("Why this campaign exists now — what a writer reads first."),
  }),
  intent: z.object({
    objective: z.enum(CAMPAIGN_OBJECTIVES),
    targets: z.array(TargetSchema),
    products: z.array(ProductSchema),
    keywords: z.array(z.string().max(MAX_TEXT_CHARS)),
  }),
  guardrails: z.object({
    avoidComplements: z
      .array(BrandRuleSchema)
      .describe("Added to the brand's guardrails for this campaign only."),
    toneOverrides: z
      .string()
      .max(MAX_TEXT_CHARS)
      .describe("Replaces the brand's tone while this runs. '' to keep it."),
  }),
});

const ReviewSchema = z.object({
  index: z.number().int().describe("Which candidate, 1-based, in order given."),
  verdict: z.enum(["strong", "workable", "weak"]),
  rationale: z
    .string()
    .max(MAX_TEXT_CHARS)
    .describe(
      "Why, in the brand's language — the person reads this to choose.",
    ),
  risks: z
    .array(z.string().max(MAX_TEXT_CHARS))
    .describe("What could go wrong, or what is unverified. Empty if none."),
});

const SYSTEM = `You propose blog campaigns for a brand. A campaign is a temporary content pillar: a moment the brand writes into — a launch, a date, a search it does not answer, stock that needs to move — with a period, a target and an objective.

WRITE EVERY NAME, NOTE AND DESCRIPTION IN THE BRAND'S OWN LANGUAGE, the one reported as \`language\`. These instructions are in English because they are instructions; a campaign is content.

DO NOT FORCE VARIETY. You are told a maximum, not a quota. If the seed already pins the campaign down — a named date, one product line, a single angle — return ONE. Return several only when the seed genuinely admits different readings, and say in each rationale what makes that reading different from the others. Three near-duplicates are worse than one good campaign, because the person has to read all three to find that out.

NEVER INVENT THE STORE. Targets and products may only come from what the tools actually reported. If no store data came back, return empty \`targets\` and \`products\` and record what you could not check. A made-up product URL is worse than a blank field: a blank field asks to be filled, a wrong URL gets published.

BUILDING A LINK IS NOT INVENTING ONE. When you are given the brand's store address, you may join it to a path, slug or \`linkText\` a tool reported — that address plus that slug is a link the store itself authored. What you may never do is guess the slug. And never use a host a tool handed you: catalogue APIs answer on internal addresses (\`*.vtexcommercestable.com.br\` and the like) that work today and point nowhere a customer should be sent. Use the brand's store address as the origin, always. With no store address given, leave \`url\` empty rather than reaching for the internal one.

A PRODUCT WITHOUT A LINK IS STILL A PRODUCT. If the tools named a product but reported no URL and no images, return it anyway with its id, name, category and description — the person completes it in the editor with two clicks. Dropping it loses the one thing you learned. The same goes for a target: an id and a name are worth more than an empty list.

HIGHLIGHTED PRODUCTS ARE A SHELF, NOT AN EXAMPLE. One product is almost never the right answer: a post that names a single item reads like an ad for it. You are given the store's catalogue as a list — return every entry in it that fits this campaign, by its \`id\` and \`name\`. Usually a handful, and up to a dozen when the list has them. Returning one of fifteen is a failure to choose, not a choice. If the list genuinely holds only one that fits, say so in the trigger note.

YOU DO NOT WRITE LINKS OR IMAGES FOR A CATALOGUED PRODUCT. Give the \`id\` and leave \`url\` and \`images\` empty: they are attached afterwards from the catalogue itself, verbatim. The id is what identifies the record, so retyping the rest only risks a URL that does not load. Fill them yourself ONLY for a product no catalogue entry covers, copying what a tool reported character for character.

A COLLECTION HAS NO ADDRESS. Collections are clusters the store filters by, identified by id. Set \`url\` to '' for them and put the id in \`id\`. Only a category gets a URL.

The same goes for figures. A price, a stock level or a traffic number belongs here only if a tool returned it, copied exactly.

DATES. You are given today's date. A seasonal campaign should carry the period it actually runs. When the moment has no fixed date, use null rather than guessing — a wrong date is read as a commitment.

Set \`keywords\` to what this campaign wants to be found by, starting from the seed's terms but not limited to them.

Fill \`guardrails\` only where this campaign needs something the brand's standing context does not already say. An empty guardrail is the normal case.

Do not repeat a campaign the brand already has — you are given their names.`;

const REVIEW_SYSTEM = `You review proposed blog campaigns for the person who has to choose between them. You did not write them.

Judge each on three things: whether it answers the seed, whether it is specific enough to write from, and whether its targets, products and figures are grounded in what the tools actually reported rather than assumed.

- \`strong\`: a writer could start today, and the store data backs it.
- \`workable\`: the idea holds, but something needs filling in or checking first.
- \`weak\`: too vague to write from, duplicates another candidate, or rests on facts nothing confirmed.

A campaign with empty targets and products is NOT weak for that reason alone when no store data was available — say that is what needs filling, and judge the thinking.

List under \`risks\` anything unverified, anything that could age badly, and any claim you could not trace to the grounding. Be concrete: "the price cited appears nowhere in the tool results" beats "check the facts".

Write the rationale in the brand's own language — the person reads it to decide.`;

function renderRules(
  label: string,
  rules: { name: string; value: string }[] | undefined,
): string | null {
  if (!rules?.length) return null;
  const lines = rules
    .map((r) => `- ${r.name}${r.value ? `: ${r.value}` : ""}`)
    .join("\n");
  return `## ${label}\n${lines}`;
}

function renderBrand(
  brand: Partial<z.infer<typeof BlogContextSchema>>,
): string {
  return (
    [
      brand.companyName && `## Brand\n${brand.companyName}`,
      brand.description && `## What it does\n${brand.description}`,
      brand.language && `## Language to write in\n${brand.language}`,
      brand.tone && `## Tone of voice\n${brand.tone}`,
      brand.targetAudience && `## Audience\n${brand.targetAudience}`,
      brand.storeUrl &&
        `## The store's address\n${brand.storeUrl}\n\nEvery link you write belongs on this origin. Join it to the slug or path a tool reported; never to a host a tool reported.`,
      renderRules("Editorial instructions (dos)", brand.dos),
      renderRules("Guardrails (never do this)", brand.avoid),
      renderRules("Special dates", brand.specialDates),
    ]
      .filter(Boolean)
      .join("\n\n") || "No brand profile has been filled in yet."
  );
}

/**
 * The shelf, as the generator sees it.
 *
 * JSON rather than prose because the model is meant to copy out of it, and a
 * field it can address by name is harder to paraphrase than a sentence. This is
 * where the image URLs and the composed product links live — the markdown
 * grounding above has already lost them.
 */
function renderCatalogue(catalogue: Catalogue): string | null {
  if (catalogue.products.length === 0 && catalogue.targets.length === 0) {
    return null;
  }
  const shown = {
    products: catalogue.products.slice(0, MAX_CATALOGUE_IN_PROMPT).map(trim),
    targets: catalogue.targets.slice(0, MAX_CATALOGUE_IN_PROMPT).map(trim),
  };
  return `## The store's actual catalogue — choose from here\n\nTranscribed from the same tool results, field by field. It holds ${catalogue.products.length} product(s) and ${catalogue.targets.length} target(s). Take every entry that fits this campaign and return it by its \`id\` — returning one of ${catalogue.products.length} is a failure to choose, not a choice. The \`url\` and the images are attached from here afterwards, so you need only the id, the name and why it belongs.\n\n${JSON.stringify(shown)}`;
}

/** The catalogue costs prompt either way; images are the part it cannot spend on. */
function trim<T extends object>(entry: T): Omit<T, "images"> {
  const { images: _images, ...rest } = entry as T & { images?: unknown };
  return rest as Omit<T, "images">;
}

/**
 * Attach what the store reported to what the model chose.
 *
 * The model picks by id and writes the argument; the address and the images
 * come from the catalogue, in code. Copying them was the model's job for
 * exactly one run, and it lost every image doing it — a transcription step
 * nobody needs, since the id already identifies the record.
 *
 * An entry with no match keeps whatever the model wrote: that is the
 * ungrounded path, where a name and a description are still worth having.
 */
export function hydrate<
  T extends { id: string; url: string; images?: string[]; category?: string },
>(items: T[], entries: { id: string; url: string; images?: string[] }[]): T[] {
  const byId = new Map(
    entries.map((entry) => [entry.id.trim().toLowerCase(), entry]),
  );
  return items.map((item) => {
    const found = byId.get(item.id.trim().toLowerCase());
    if (!found) {
      return item.images
        ? { ...item, images: item.images.slice(0, MAX_CAMPAIGN_PRODUCT_IMAGES) }
        : item;
    }
    return {
      ...item,
      url: found.url || item.url,
      ...(item.images === undefined
        ? {}
        : {
            images: (found.images ?? []).slice(0, MAX_CAMPAIGN_PRODUCT_IMAGES),
          }),
    };
  });
}

/**
 * A collection is a cluster the store filters by, not a page, so it has no
 * address of its own. The prompt says so; this is what makes it true.
 */
export function withoutCollectionUrls<T extends { kind: string; url: string }>(
  targets: T[],
): T[] {
  return targets.map((target) =>
    target.kind === "collection" ? { ...target, url: "" } : target,
  );
}

/** What a proposal is checked against: the catalogue first, raw output after. */
export interface Evidence {
  ids: Set<string>;
  names: Set<string>;
  raw: string;
}

const norm = (value: string) => value.trim().toLowerCase();

/** The index a campaign's targets and products are checked against. */
export function evidenceFrom(catalogue: Catalogue, raw: string): Evidence {
  const entries = [...catalogue.products, ...catalogue.targets];
  return {
    ids: new Set(entries.map((e) => norm(e.id)).filter(Boolean)),
    names: new Set(entries.map((e) => norm(e.name)).filter(Boolean)),
    raw: raw.toLowerCase(),
  };
}

/**
 * Drop anything the store never reported.
 *
 * The prompt forbids inventing a target or a product, but a prompt is a request
 * and this is the guarantee. With nothing to check against, everything goes —
 * that is the honest reading of "nothing was verifiable", and the UI says so
 * rather than showing invented links.
 *
 * Matching is by id against the extracted catalogue first, because that is
 * exact. The raw tool output is the fallback: it is what a tool actually
 * returned, so a name in it is a name the store used. What this must never
 * match against is the prose summary — that is one model's paraphrase, and a
 * category it chose to abbreviate is not a category the store stopped having.
 */
export function groundedOnly<
  T extends { id?: string; name: string; url: string },
>(items: T[], evidence: Evidence): T[] {
  const indexed = evidence.ids.size > 0 || evidence.names.size > 0;
  if (!indexed && !evidence.raw.trim()) return [];
  return items.filter((item) => {
    const id = norm(item.id ?? "");
    const name = norm(item.name);
    if (id && evidence.ids.has(id)) return true;
    if (name && evidence.names.has(name)) return true;
    if (!evidence.raw) return false;
    return (
      (!!id && evidence.raw.includes(id)) ||
      (!!name && evidence.raw.includes(name))
    );
  });
}

/**
 * What the person is told was missing, given what actually happened.
 *
 * The outcomes are kept apart because they ask for different things, and
 * because telling someone nothing answered when their store was mid-reply is
 * how they go off and debug a connection that works.
 */
const GAP_CODES = [
  "no-site",
  "no-tools",
  "timeout-partial",
  "timeout-empty",
  "failed",
  "nothing-useful",
  "targets-dropped",
  "products-dropped",
] as const;

const GapSchema = z.object({
  code: z.enum(GAP_CODES),
  /** How many were dropped. Absent for the codes that count nothing. */
  count: z.number().int().optional(),
});
export type Gap = z.infer<typeof GapSchema>;

/**
 * A gap as a sentence, for the model reading `modelSummary`.
 *
 * The UI words these itself, from the code, in the person's own locale — this
 * exists because an agent calling the tool has no translation table and a bare
 * `targets-dropped` tells it nothing.
 */
function gapInEnglish(gap: Gap): string {
  switch (gap.code) {
    case "no-site":
      return "the site has no connections to read.";
    case "no-tools":
      return "the connected systems offer no read-only tools.";
    case "timeout-partial":
      return `the search ran out of time after ${gap.count} call(s).`;
    case "timeout-empty":
      return "the search ran out of time before anything came back.";
    case "failed":
      return "the search for store data could not be completed.";
    case "nothing-useful":
      return "the connected systems reported nothing useful for this seed.";
    case "targets-dropped":
      return `${gap.count} proposed target(s) were dropped as ungrounded.`;
    case "products-dropped":
      return `${gap.count} proposed product(s) were dropped as ungrounded.`;
  }
}

export function describeGaps(
  report: { toolNames: string[]; calls: unknown[]; outcome: GroundingOutcome },
  grounding: string,
  dropped: { targets: number; products: number },
): Gap[] {
  const gaps: Gap[] = [];
  const answered = report.calls.length;
  if (report.outcome === "no-site") {
    gaps.push({ code: "no-site" });
  } else if (report.outcome === "no-tools") {
    gaps.push({ code: "no-tools" });
  } else if (report.outcome === "timeout") {
    gaps.push(
      answered > 0
        ? { code: "timeout-partial", count: answered }
        : { code: "timeout-empty" },
    );
  } else if (report.outcome === "failed") {
    gaps.push({ code: "failed" });
  } else if (!grounding.trim()) {
    gaps.push({ code: "nothing-useful" });
  }
  if (dropped.targets > 0) {
    gaps.push({ code: "targets-dropped", count: dropped.targets });
  }
  if (dropped.products > 0) {
    gaps.push({ code: "products-dropped", count: dropped.products });
  }
  return gaps;
}

/** The review that stands in when the reviewer itself fails. */
export function unreviewed(count: number): z.infer<typeof ReviewSchema>[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    verdict: "workable" as const,
    rationale: "",
    risks: [],
  }));
}

/**
 * Pair reviews back to candidates by index.
 *
 * Out-of-range and duplicate indices are ignored rather than trusted: a review
 * attached to the wrong campaign is worse than no review, because the person
 * acts on it.
 */
export function pairReviews<T>(
  candidates: T[],
  reviews: z.infer<typeof ReviewSchema>[],
): (T & { review: Omit<z.infer<typeof ReviewSchema>, "index"> })[] {
  const byIndex = new Map<number, z.infer<typeof ReviewSchema>>();
  for (const review of reviews) {
    if (!Number.isInteger(review.index)) continue;
    if (review.index < 1 || review.index > candidates.length) continue;
    if (!byIndex.has(review.index)) byIndex.set(review.index, review);
  }
  return candidates.map((candidate, i) => {
    const found = byIndex.get(i + 1);
    return {
      ...candidate,
      review: {
        verdict: found?.verdict ?? ("workable" as const),
        rationale: found?.rationale ?? "",
        risks: found?.risks ?? [],
      },
    };
  });
}

async function reviewCampaigns(
  ctx: StudioContext,
  organizationId: string,
  candidates: z.infer<typeof CampaignDraftSchema>[],
  grounding: string,
  language: string | undefined,
): Promise<z.infer<typeof ReviewSchema>[]> {
  try {
    const tier = await resolveTier(ctx, "smart");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organizationId,
    );
    const { object } = await retryGenerateObject({
      model: provider.aiSdk.languageModel(tier.modelId),
      schema: z.object({ reviews: z.array(ReviewSchema) }),
      system: REVIEW_SYSTEM,
      prompt: [
        language && `## Language to write the rationale in\n${language}`,
        renderGrounding(grounding) ??
          "## What the store reported\nNothing — no connected system answered.",
        `## The candidates\n${JSON.stringify(candidates, null, 2)}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    return object.reviews;
  } catch (err) {
    console.warn("[BLOG_CAMPAIGN_SUGGEST] review pass failed", err);
    return unreviewed(candidates.length);
  }
}

export const BLOG_CAMPAIGN_SUGGEST = defineTool({
  name: "BLOG_CAMPAIGN_SUGGEST",
  description:
    "Propose blog campaigns from a seed — keywords plus a sentence about the moment — by reading the site's own connected systems (analytics, catalogue) for what is actually selling, searched for or stuck. Returns up to `count` candidates, each with a separate review, plus what could not be checked. Does not persist: the caller saves the chosen ones as campaign blocks.",
  annotations: {
    title: "Suggest Campaigns",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    seed: z.object({
      keywords: z
        .array(z.string().max(MAX_TEXT_CHARS))
        .max(MAX_KEYWORDS)
        .default([])
        .describe("The terms this campaign should aim at."),
      prompt: z
        .string()
        .max(MAX_PROMPT_CHARS)
        .describe("What the moment is, in the operator's own words."),
    }),
    brand: BlogContextSchema.partial().describe(
      "The site's editorial brand context. Every field is optional.",
    ),
    existingNames: z
      .array(z.string().max(MAX_TEXT_CHARS))
      .max(MAX_EXISTING_NAMES)
      .default([])
      .describe("Campaigns the brand already has, so none is proposed twice."),
    count: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(3)
      .describe("The most candidates to return. Fewer is a valid answer."),
    virtualMcpId: VirtualMcpIdSchema,
  }),
  outputSchema: z.object({
    campaigns: z.array(
      CampaignDraftSchema.extend({
        review: ReviewSchema.omit({ index: true }),
      }),
    ),
    /** True when a connected system actually answered. */
    grounded: z.boolean(),
    /** The tools actually called — offered is not the same as consulted. */
    toolsUsed: z.array(z.string()),
    /** What could not be checked, as codes the caller words in its own locale. */
    gaps: z.array(GapSchema),
  }),

  // Two model passes plus a tool-calling sweep — a spent envelope has to stop it.
  requiresAiBudget: true,

  modelSummary: (r) =>
    `${r.campaigns.length} campaign(s) proposed: ${r.campaigns
      .map((c) => `${c.name} (${c.review.verdict})`)
      .join(
        "; ",
      )}. ${r.grounded ? "Grounded in the site's systems." : "No store data available."}${
      r.gaps.length > 0
        ? ` Not checked: ${r.gaps.map(gapInEnglish).join(" ")}`
        : ""
    } Not yet saved.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const brandName = input.brand.companyName ?? "this brand";
    const report = await groundSiteReport(ctx, organizationId, {
      virtualMcpId: input.virtualMcpId,
      language: input.brand.language,
      label: "BLOG_CAMPAIGN_SUGGEST",
      maxSteps: GROUNDING_MAX_STEPS,
      timeoutMs: GROUNDING_TIMEOUT_MS,
      task: `Proposing blog campaigns for ${brandName}, starting from: ${input.seed.prompt}`,
      wanted: [
        "What is selling and what has stalled. For EACH product, report its name, id, main category, price, and its image URLs verbatim, plus its slug or `linkText` — a catalogue API returns that instead of an address. Several products, not one example: a shelf is the useful answer.",
        "Which categories or collections these products sit in, with their ids and their slugs or paths.",
        "What readers arrive searching for, which pages they land on, and which queries bring traffic the brand does not rank for.",
        "Any promotion, season or launch already in flight.",
        `Anything bearing on these terms: ${input.seed.keywords.join(", ") || "(none given)"}.`,
      ].join("\n"),
    });

    const grounding = report.grounding;
    const catalogue = await extractCatalogue(
      ctx,
      organizationId,
      report.evidence,
      input.brand.storeUrl,
      "BLOG_CAMPAIGN_SUGGEST",
    );
    const evidence = evidenceFrom(catalogue, report.evidence);
    const today = new Date().toISOString().slice(0, 10);

    const tier = await resolveTier(ctx, "smart");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organizationId,
    );

    const { object } = await retryGenerateObject({
      model: provider.aiSdk.languageModel(tier.modelId),
      schema: z.object({ campaigns: z.array(CampaignDraftSchema) }),
      system: SYSTEM,
      prompt: [
        `## Today\n${today}`,
        renderBrand(input.brand),
        `## The seed\n${input.seed.prompt}`,
        input.seed.keywords.length > 0 &&
          `## Terms to aim at\n${input.seed.keywords.map((k) => `- ${k}`).join("\n")}`,
        renderGrounding(grounding) ??
          "## What the store reported\nNo connected system answered. Leave `targets` and `products` empty — do not fill them from what you know about the category.",
        renderCatalogue(catalogue),
        input.existingNames.length > 0 &&
          `## Campaigns this brand already has\n${input.existingNames.map((n) => `- ${n}`).join("\n")}`,
        `## Your task\nPropose at most ${input.count} campaign(s). One is a good answer when the seed only supports one.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });

    let droppedTargets = 0;
    let droppedProducts = 0;
    const candidates = object.campaigns
      .slice(0, input.count)
      .map((campaign) => {
        const targets = withoutCollectionUrls(
          hydrate(
            groundedOnly(campaign.intent.targets, evidence),
            catalogue.targets,
          ),
        );
        const products = hydrate(
          groundedOnly(campaign.intent.products, evidence),
          catalogue.products,
        );
        droppedTargets += campaign.intent.targets.length - targets.length;
        droppedProducts += campaign.intent.products.length - products.length;
        return {
          ...campaign,
          intent: { ...campaign.intent, targets, products },
        };
      });

    const reviews =
      candidates.length > 0
        ? await reviewCampaigns(
            ctx,
            organizationId,
            candidates,
            grounding,
            input.brand.language,
          )
        : [];

    return {
      campaigns: pairReviews(candidates, reviews),
      grounded: report.outcome === "ok" && grounding.trim().length > 0,
      toolsUsed: [...new Set(report.calls.map((call) => call.tool))],
      gaps: describeGaps(report, grounding, {
        targets: droppedTargets,
        products: droppedProducts,
      }),
    };
  },
});

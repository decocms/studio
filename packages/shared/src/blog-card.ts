/**
 * A blogpost card: one post's way through the content track, from the
 * hypothesis its agent brings to the draft it commits.
 *
 * Stored as JSON in the organization's brand folder,
 * `home/brands/<brand>/cards/<id>.json`, beside the campaigns it belongs to.
 * The card's agent writes it as it works and a person moves it across the
 * board. Both go through `BLOG_CARD_UPDATE`, which merges a patch into what is
 * stored instead of replacing the file, so neither loses the other's fields.
 *
 * Every stored level is `.loose()` and nothing transforms: the same schema is
 * the tools' output schema, and a field this version does not know about yet
 * must survive a write by this version.
 */

import { z } from "zod";

/**
 * The id of a post the blog writes: the last segment of its planning key,
 * `blog-manager/posts/<id>`. A card's id is its post's id, so the draft it
 * commits and the branch it commits to are both named after it.
 */
export const BLOG_POST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A card is a document of notes, not the post itself; the post is the draft. */
export const MAX_BLOG_CARD_BYTES = 256_000;

export const BLOG_CARD_STATUSES = [
  "ideas",
  "generating",
  "awaiting_review",
  "scheduled",
  "published",
] as const;
export type BlogCardStatus = (typeof BLOG_CARD_STATUSES)[number];

/** Where an execution run is, in the order it gets there. */
export const BLOG_CARD_STAGES = [
  "grounding",
  "drafting",
  "illustrating",
  "assembling",
  "writing",
  "done",
] as const;
export type BlogCardStage = (typeof BLOG_CARD_STAGES)[number];

/** What a run on a card is for: bringing the hypothesis, or writing the post. */
export const BLOG_CARD_PHASES = ["hypothesis", "execute"] as const;
export type BlogCardPhase = (typeof BLOG_CARD_PHASES)[number];

/** The systems a hypothesis may cite. Each is one card on the hypothesis tab. */
export const BLOG_EVIDENCE_SOURCES = [
  "gsc",
  "ga4",
  "vtex",
  "calendar",
  "brand",
] as const;
export type BlogEvidenceSource = (typeof BLOG_EVIDENCE_SOURCES)[number];

export const BLOG_GUARDRAIL_ORIGINS = ["brand", "campaign"] as const;

const KeywordSchema = z
  .object({
    term: z.string().min(1).max(120),
    volume: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Monthly searches, only when a system reported the number."),
  })
  .loose();

const EvidenceSchema = z
  .object({
    source: z.enum(BLOG_EVIDENCE_SOURCES),
    figure: z
      .string()
      .max(80)
      .optional()
      .describe(
        "The number exactly as the tool reported it, such as `1.240 impressões` or `posição 8`.",
      ),
    fact: z
      .string()
      .min(1)
      .max(600)
      .describe("What the number says about the post, in one sentence."),
    tool: z
      .string()
      .max(120)
      .optional()
      .describe("The tool the figure came from, so a person can check it."),
  })
  .loose();

const GuardrailSchema = z
  .object({
    text: z.string().min(1).max(400),
    origin: z.enum(BLOG_GUARDRAIL_ORIGINS),
  })
  .loose();

export const BlogCardHypothesisSchema = z
  .object({
    title: z.string().max(300).describe("The post's working headline."),
    statement: z
      .string()
      .max(2_000)
      .describe(
        "The thesis: what the post argues, for whom, and why now. Becomes the draft's brief.",
      ),
    angle: z
      .string()
      .max(1_000)
      .describe("How this post differs from what is already out there."),
    format: z
      .object({
        name: z.string().max(120),
        value: z.string().max(8_000).optional(),
      })
      .loose()
      .describe("One of the brand's formats, with its brief."),
    keywords: z.array(KeywordSchema).max(30),
    evidence: z
      .array(EvidenceSchema)
      .max(20)
      .describe("The figures the hypothesis stands on, one per finding."),
    guardrails: z
      .array(GuardrailSchema)
      .max(20)
      .describe("What this post must not do, from the brand and the campaign."),
    objective: z
      .string()
      .max(600)
      .describe(
        "What this post moves, as its share of the campaign's goal: the figure it aims at, and how that adds up to the goal.",
      ),
    metric: z
      .string()
      .max(300)
      .describe("What would show the post worked, such as clicks from search."),
    groundingOutcome: z
      .string()
      .max(40)
      .describe(
        "How the store's systems answered while gathering the evidence: ok (all that were asked), partial (some) or none.",
      ),
  })
  .partial()
  .loose();

/** The post as it fills in: the agent's draft, then its image addresses. Partial throughout. */
export const BlogCardPostSchema = z
  .object({
    title: z.string(),
    excerpt: z.string(),
    seo: z
      .object({ title: z.string(), description: z.string() })
      .partial()
      .loose(),
    cover: z
      .object({ url: z.string(), alt: z.string(), prompt: z.string() })
      .partial()
      .loose(),
    sections: z.array(
      z
        .object({
          type: z.string(),
          props: z.record(z.string(), z.unknown()),
          productIds: z.array(z.string()),
        })
        .partial()
        .loose(),
    ),
    gaps: z.array(
      z.object({ code: z.string(), count: z.number().optional() }).loose(),
    ),
  })
  .partial()
  .loose();

const RunSchema = z
  .object({
    phase: z.enum(BLOG_CARD_PHASES),
    requestedAt: z.string(),
    requestedBy: z.string(),
  })
  .loose();

export const BlogCardSchema = z
  .object({
    id: z.string().regex(BLOG_POST_ID),
    kind: z.literal("blogpost"),
    status: z.enum(BLOG_CARD_STATUSES),
    virtualMcpId: z.string().describe("The site the post is written for."),
    campaignId: z
      .string()
      .optional()
      .describe("The campaign this post belongs to, by its record id."),
    prompt: z
      .string()
      .max(2_000)
      .optional()
      .describe("What the person asked to explore when they created it."),
    threadId: z
      .string()
      .optional()
      .describe(
        "The card's chat, where its agent works. Set by its first run.",
      ),
    branch: z
      .string()
      .optional()
      .describe("The site branch the post is written on, `blog-<id>`."),
    fileConfigId: z
      .string()
      .optional()
      .describe("The organization's bucket the post's images go to."),
    stage: z.enum(BLOG_CARD_STAGES).optional(),
    hypothesis: BlogCardHypothesisSchema.optional(),
    post: BlogCardPostSchema.optional(),
    postKey: z
      .string()
      .optional()
      .describe("The draft's block, `blog-manager/posts/<id>`, once written."),
    commit: z.string().optional().describe("The commit that carries it."),
    error: z
      .string()
      .max(2_000)
      .optional()
      .describe("Why the last run stopped short, until the next one starts."),
    run: RunSchema.optional().describe("The last run requested on the card."),
    createdBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .loose();
export type BlogCard = z.infer<typeof BlogCardSchema>;

/**
 * What a write may change: every field but the ones the server owns (id,
 * kind, the chat, the branch, the run and the timestamps). A JSON merge
 * patch: objects merge, arrays replace, and `null` removes a field.
 */
export const BlogCardPatchSchema = z
  .object({
    status: z.enum(BLOG_CARD_STATUSES),
    virtualMcpId: z.string().min(1).max(256),
    campaignId: z.string().min(1).max(128).nullable(),
    prompt: z.string().max(2_000).nullable(),
    fileConfigId: z.string().min(1).max(256).nullable(),
    stage: z.enum(BLOG_CARD_STAGES).nullable(),
    hypothesis: BlogCardHypothesisSchema.nullable(),
    post: BlogCardPostSchema.nullable(),
    postKey: z.string().max(256).nullable(),
    commit: z.string().max(256).nullable(),
    error: z.string().max(2_000).nullable(),
  })
  .partial()
  .strict();
export type BlogCardPatch = z.infer<typeof BlogCardPatchSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** RFC 7396: objects merge key by key, `null` removes, anything else replaces. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const merged: Record<string, unknown> = isPlainObject(target)
    ? { ...target }
    : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = mergePatch(merged[key], value);
  }
  return merged;
}

/** The card with a patch merged in and `updatedAt` moved to `now`. */
export function applyBlogCardPatch<T extends Record<string, unknown>>(
  card: T,
  patch: BlogCardPatch,
  now: string,
): T {
  return { ...(mergePatch(card, patch) as T), updatedAt: now };
}

/**
 * The branch a card's post is written on. Flat, with no slash: a GitLab
 * project can protect every branch whose name has one, and then refuses the
 * push for every role.
 */
export function blogCardBranch(id: string): string {
  return `blog-${id}`;
}

/** Thread metadata key marking a card's chat, `{ cardId, brand }`. */
export const BLOG_CARD_THREAD_KEY = "blogCard";

const BlogCardThreadSchema = z.object({
  cardId: z.string().regex(BLOG_POST_ID),
  brand: z.string().min(1),
});
export type BlogCardThread = z.infer<typeof BlogCardThreadSchema>;

/** The card a chat works, from its thread's metadata, or null for any other. */
export function blogCardOfThread(
  metadata: Record<string, unknown> | null | undefined,
): BlogCardThread | null {
  const parsed = BlogCardThreadSchema.safeParse(
    metadata?.[BLOG_CARD_THREAD_KEY],
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Org-scoped SSE event pushed whenever a card is written. Its `data` is the
 * whole card; the board upserts it and drops one older than what it holds.
 */
export const BLOG_CARD_UPDATED_EVENT = "blog.card.updated";

/** Org-scoped SSE event pushed when a card is deleted. Its `data` is `{ id }`. */
export const BLOG_CARD_DELETED_EVENT = "blog.card.deleted";

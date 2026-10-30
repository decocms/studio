/**
 * A blog campaign: the closed sets it is described by, and the parts its agent
 * writes while shaping it — the evidence, the briefings it suggests, the one a
 * person chose.
 *
 * Shared because both ends read them: the page renders what the agent wrote,
 * and the API checks every write against the same lists. Restating them on one
 * side would mean a value added there and silently rejected by the other.
 */

import { z } from "zod";
import { BLOG_EVIDENCE_SOURCES } from "./blog-card";

export const CAMPAIGN_STATUSES = [
  "draft",
  "active",
  "paused",
  "finished",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/**
 * Why the campaign exists. A closed set on purpose: it is the axis a board
 * groups by and what the generator reads to pick an angle. Free text here would
 * be a field nobody could group or reason about.
 */
export const CAMPAIGN_TRIGGERS = [
  "launch",
  "seasonal",
  "trend",
  "seo_gap",
  "inventory",
  "partnership",
  "reputation",
] as const;
export type CampaignTrigger = (typeof CAMPAIGN_TRIGGERS)[number];

export const CAMPAIGN_OBJECTIVES = [
  "awareness",
  "education",
  "conversion",
  "retention",
  "repositioning",
] as const;
export type CampaignObjective = (typeof CAMPAIGN_OBJECTIVES)[number];

/**
 * What a campaign's goal is counted in: a figure GA4, Search Console or VTEX
 * reports, so the goal can be checked rather than argued about.
 */
export const CAMPAIGN_GOAL_METRICS = [
  "organic_sessions",
  "sessions",
  "search_clicks",
  "search_impressions",
  "conversions",
  "revenue",
] as const;
export type CampaignGoalMetric = (typeof CAMPAIGN_GOAL_METRICS)[number];

/** A target is the slice a campaign argues for — never a single product. */
export const CAMPAIGN_TARGET_KINDS = ["category", "collection"] as const;
export type CampaignTargetKind = (typeof CAMPAIGN_TARGET_KINDS)[number];

/** How many images a campaign keeps per product; the post picks one. */
export const MAX_CAMPAIGN_PRODUCT_IMAGES = 3;

/**
 * Product photographs one illustration request may be offered.
 *
 * Shared for the same reason the sets above are: the client gathers them and
 * `BLOG_POST_ILLUSTRATE` validates the array, and a client that flattens a
 * campaign product by product overruns any cap it cannot see — five products
 * with three photographs each is fifteen, and the rejected request means no
 * cover at all on exactly the well-stocked campaigns that most deserve one.
 */
export const MAX_OFFERED_PHOTOS = 12;

/** A campaign's key in the editor's decofile view; its file is named by the rest. */
export const CAMPAIGN_KEY_PREFIX = "blog-manager/campaigns/";

/** A seed's key, and what a campaign generated from it stores as `seedKey`. */
export const CAMPAIGN_SEED_KEY_PREFIX = "blog-manager/campaign-seeds/";

/** How many briefings one suggestion offers. */
export const MAX_CAMPAIGN_BRIEFINGS = 3;

/** One briefing an agent suggests: a campaign in a sentence, and the figure it stands on. */
export const CampaignBriefingOptionSchema = z
  .object({
    id: z.string().min(1).max(40),
    title: z.string().min(1).max(160),
    idea: z
      .string()
      .min(1)
      .max(800)
      .describe(
        "The campaign in two or three sentences: the moment, the slice of the store, why now.",
      ),
    figure: z
      .string()
      .max(80)
      .optional()
      .describe("The number it stands on, exactly as a tool reported it."),
    source: z.enum(BLOG_EVIDENCE_SOURCES).optional(),
  })
  .loose();
export type CampaignBriefingOption = z.infer<
  typeof CampaignBriefingOptionSchema
>;

/** The briefing a campaign is developed from: one of the suggestions, or a person's own words. */
export const CampaignBriefingSchema = z
  .object({
    text: z.string().trim().min(1).max(2_000),
    optionId: z
      .string()
      .max(40)
      .optional()
      .describe("The suggestion it came from, when it came from one."),
  })
  .loose();
export type CampaignBriefing = z.infer<typeof CampaignBriefingSchema>;

/** The last run Studio started on a campaign. Only the server writes it. */
export const CampaignRunSchema = z
  .object({ requestedAt: z.string(), requestedBy: z.string() })
  .loose();
export type CampaignRun = z.infer<typeof CampaignRunSchema>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Whether a campaign's agent has developed it: it has a name and a reason to run now. */
export function campaignDeveloped(record: Record<string, unknown>): boolean {
  const trigger = record.trigger;
  const note =
    trigger && typeof trigger === "object"
      ? text((trigger as Record<string, unknown>).note)
      : "";
  return text(record.campaignName) !== "" && note !== "";
}

/** What a draft's agent does next: suggest briefings, develop the chosen one, or nothing until a person acts. */
export function campaignNextStep(
  record: Record<string, unknown>,
): "suggest" | "develop" | null {
  if ((record.status ?? "draft") !== "draft") return null;
  if (campaignDeveloped(record)) return null;
  if (CampaignBriefingSchema.safeParse(record.briefing).success) {
    return "develop";
  }
  const offered = Array.isArray(record.briefings) ? record.briefings.length : 0;
  return offered > 0 ? null : "suggest";
}

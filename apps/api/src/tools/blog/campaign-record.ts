import { BlogEvidenceSchema, mergeJsonPatch } from "@decocms/shared/blog-card";
import {
  CAMPAIGN_STATUSES,
  type CampaignBriefing,
  CampaignBriefingOptionSchema,
  CampaignBriefingSchema,
  campaignDeveloped,
  type CampaignRun,
  CampaignRunSchema,
  MAX_CAMPAIGN_BRIEFINGS,
} from "@decocms/shared/blog-campaign";
import { z } from "zod";
import { CampaignDraftSchema, CampaignGoalSchema } from "./schema";

/**
 * A campaign's record: what it says, what its agent wrote while shaping it,
 * and who may change which part. Pure, so the tools and their tests share it.
 */

const MAX_CAMPAIGN_EVIDENCE = 20;

/**
 * A campaign as stored: what its agent develops, plus the bookkeeping the board
 * keeps. `campaignName` and not `name` because the CMS stores these as decofile
 * blocks too, where `name` is the block's own key.
 */
export const StoredCampaignSchema = CampaignDraftSchema.omit({ name: true })
  .extend({
    campaignName: z.string().describe("What someone calls this campaign."),
    seedKey: z
      .string()
      .describe(
        "The seed an older campaign was generated from, as `blog-manager/campaign-seeds/<id>`. Empty otherwise.",
      ),
    goal: CampaignGoalSchema.describe(
      "What the campaign is for, in a figure someone can check. Every post written for it is a step toward this.",
    ),
    status: z.enum(CAMPAIGN_STATUSES),
    threadId: z
      .string()
      .describe(
        "The chat that shapes this campaign: a card's, or the campaign's own.",
      ),
    evidence: z
      .array(BlogEvidenceSchema)
      .max(MAX_CAMPAIGN_EVIDENCE)
      .describe("What the store's systems reported, strongest first."),
    briefings: z
      .array(CampaignBriefingOptionSchema)
      .max(MAX_CAMPAIGN_BRIEFINGS)
      .describe("The briefings its agent suggested, for a person to choose."),
    briefing: CampaignBriefingSchema.describe(
      "The briefing it is developed from.",
    ),
    run: CampaignRunSchema.describe("The last run Studio started on it."),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .partial()
  .loose();

/** What may change in a campaign, merged in rather than replacing it. */
export const CampaignPatchSchema = z
  .object({
    campaignName: CampaignDraftSchema.shape.name,
    period: CampaignDraftSchema.shape.period.partial(),
    trigger: CampaignDraftSchema.shape.trigger.partial(),
    intent: CampaignDraftSchema.shape.intent.partial(),
    guardrails: CampaignDraftSchema.shape.guardrails.partial(),
    goal: CampaignGoalSchema.nullable(),
    status: z.enum(CAMPAIGN_STATUSES),
    evidence: z.array(BlogEvidenceSchema).max(MAX_CAMPAIGN_EVIDENCE).nullable(),
    briefings: z
      .array(CampaignBriefingOptionSchema)
      .max(MAX_CAMPAIGN_BRIEFINGS)
      .nullable(),
    briefing: CampaignBriefingSchema.nullable(),
  })
  .partial()
  .strict();
export type CampaignPatch = z.infer<typeof CampaignPatchSchema>;

const PERSON_KEYS: ReadonlySet<string> = new Set(["goal", "status"]);

/** Fields a patch replaces whole instead of merging into. */
const WHOLE_VALUES = ["goal", "briefing"] as const;

/** Why a patch may not land on a campaign, or null when it may. `runThreadId` is the calling run's chat, null for a person. */
export function campaignPatchRefusal(
  stored: Record<string, unknown>,
  patch: CampaignPatch,
  runThreadId: string | null,
): string | null {
  if (runThreadId) {
    if (stored.threadId !== runThreadId) {
      return "This chat writes only the campaign it shapes, and this one is shaped elsewhere.";
    }
    if ("goal" in patch || "status" in patch) {
      return "The goal and the status are a person's: leave them out of the patch.";
    }
    return null;
  }
  if (Object.keys(patch).some((key) => !PERSON_KEYS.has(key))) {
    return "A person sets only a campaign's goal and status; the rest changes in the campaign's chat.";
  }
  const from = typeof stored.status === "string" ? stored.status : "draft";
  if (patch.status === "draft" && from !== "draft") {
    return "An approved campaign is paused or finished, never sent back to draft.";
  }
  if (
    patch.status &&
    patch.status !== "draft" &&
    from === "draft" &&
    !campaignDeveloped(stored)
  ) {
    return "Its agent develops a campaign before it is approved.";
  }
  return null;
}

/** The campaign with a patch merged in, each field the patch touched checked, and `updatedAt` moved to `now`. */
export function applyCampaignPatch(
  stored: Record<string, unknown>,
  patch: CampaignPatch,
  now: string,
): Record<string, unknown> {
  const merged = mergeJsonPatch(stored, patch) as Record<string, unknown>;
  // Replaced whole: inside a goal, `metric: null` means "no measure", not "remove".
  for (const key of WHOLE_VALUES) {
    const value = patch[key];
    if (value) merged[key] = value;
  }
  const shape = StoredCampaignSchema.shape as Record<string, z.ZodType>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) continue;
    const field = shape[key];
    if (!field) continue;
    const parsed = field.safeParse(merged[key]);
    if (!parsed.success) {
      throw new Error(
        `\`${key}\` is not valid once merged: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
      );
    }
    merged[key] = parsed.data;
  }
  return { ...merged, updatedAt: now };
}

/** A campaign before its agent's first turn: no name yet, a draft, and the chat that will shape it. */
export function campaignShell(
  threadId: string,
  run: CampaignRun,
  now: string,
  briefing?: CampaignBriefing,
): Record<string, unknown> {
  return {
    campaignName: "",
    status: "draft",
    seedKey: "",
    threadId,
    run,
    ...(briefing ? { briefing } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** Why an agent may not make this BLOG_STATE_SET call: a campaign changes through BLOG_CAMPAIGN_UPDATE, and seeds and removals are a person's. */
export function agentStateWriteRefusal(
  runThreadId: string | null,
  counts: { campaigns: number; seeds: number; removals: number },
): string | null {
  if (!runThreadId) return null;
  if (counts.campaigns > 0) {
    return "A chat changes a campaign with BLOG_CAMPAIGN_UPDATE, and only the campaign it shapes.";
  }
  if (counts.seeds > 0 || counts.removals > 0) {
    return "Seeds and removals are a person's.";
  }
  return null;
}

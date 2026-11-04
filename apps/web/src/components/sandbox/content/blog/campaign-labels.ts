import type {
  CampaignObjective,
  CampaignStatus,
  CampaignTargetKind,
  CampaignTrigger,
} from "@decocms/shared/blog-campaign";
import type { TranslationKey } from "@/i18n/use-t.ts";
import type { CampaignProgress } from "./campaign-model";

/** One label map and one colour map per campaign field, so board, page and list cannot drift. */
export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, TranslationKey> = {
  draft: "sandbox.campaigns.statusDraft",
  active: "sandbox.campaigns.statusActive",
  paused: "sandbox.campaigns.statusPaused",
  finished: "sandbox.campaigns.statusFinished",
};

export const CAMPAIGN_STATUS_VARIANT: Record<
  CampaignStatus,
  "secondary" | "warning" | "success" | "outline"
> = {
  draft: "outline",
  active: "success",
  paused: "warning",
  finished: "secondary",
};

export const CAMPAIGN_TRIGGER_LABEL: Record<CampaignTrigger, TranslationKey> = {
  launch: "sandbox.campaigns.triggerLaunch",
  seasonal: "sandbox.campaigns.triggerSeasonal",
  trend: "sandbox.campaigns.triggerTrend",
  seo_gap: "sandbox.campaigns.triggerSeoGap",
  inventory: "sandbox.campaigns.triggerInventory",
  partnership: "sandbox.campaigns.triggerPartnership",
  reputation: "sandbox.campaigns.triggerReputation",
};

export const CAMPAIGN_OBJECTIVE_LABEL: Record<
  CampaignObjective,
  TranslationKey
> = {
  awareness: "sandbox.campaigns.objectiveAwareness",
  education: "sandbox.campaigns.objectiveEducation",
  conversion: "sandbox.campaigns.objectiveConversion",
  retention: "sandbox.campaigns.objectiveRetention",
  repositioning: "sandbox.campaigns.objectiveRepositioning",
};

export const CAMPAIGN_TARGET_KIND_LABEL: Record<
  CampaignTargetKind,
  TranslationKey
> = {
  category: "sandbox.campaigns.targetCategory",
  collection: "sandbox.campaigns.targetCollection",
};

/** A draft's progress; an approved campaign shows its status instead. */
export const CAMPAIGN_PROGRESS_LABEL: Record<
  Exclude<CampaignProgress, "approved">,
  TranslationKey
> = {
  researching: "contentTrack.campaign.progress.researching",
  choosing: "contentTrack.campaign.progress.choosing",
  developing: "contentTrack.campaign.progress.developing",
  review: "contentTrack.campaign.progress.review",
  stalled: "contentTrack.campaign.progress.stalled",
  idle: "contentTrack.campaign.progress.idle",
};

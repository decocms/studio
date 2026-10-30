import type { BlogCard } from "@decocms/shared/blog-card";
import type { CampaignEntry } from "./blog-data";

/** How long a requested run counts as running before it reads as stalled. */
const CAMPAIGN_RUN_STALE_MS = 30 * 60_000;

/** Where a campaign stands: being researched, waiting for a briefing, being developed, ready to approve, stalled, idle, or approved. */
export type CampaignProgress =
  | "researching"
  | "choosing"
  | "developing"
  | "review"
  | "stalled"
  | "idle"
  | "approved";

/** Whether its agent developed it: a name and a reason to run now. */
export function campaignIsDeveloped(campaign: CampaignEntry): boolean {
  return campaign.name.trim() !== "" && campaign.trigger.note.trim() !== "";
}

export function campaignProgress(
  campaign: CampaignEntry,
  now: number,
): CampaignProgress {
  if (campaign.status !== "draft") return "approved";
  if (campaignIsDeveloped(campaign)) return "review";
  const requested = Date.parse(campaign.run?.requestedAt ?? "");
  const ran = Number.isFinite(requested);
  const fresh = ran && now - requested <= CAMPAIGN_RUN_STALE_MS;
  if (campaign.briefing) return fresh ? "developing" : "stalled";
  if (campaign.briefings.length > 0) return "choosing";
  if (!ran) return "idle";
  return fresh ? "researching" : "stalled";
}

export function campaignAgentWorking(
  campaign: CampaignEntry,
  now: number,
): boolean {
  const progress = campaignProgress(campaign, now);
  return progress === "researching" || progress === "developing";
}

export type CampaignPagePhase = "briefing" | "campaign";

/** The page's phase: the briefing until the campaign is developed. */
export function campaignPagePhase(campaign: CampaignEntry): CampaignPagePhase {
  return campaign.status !== "draft" || campaignIsDeveloped(campaign)
    ? "campaign"
    : "briefing";
}

/** The campaigns a post can be written for. */
export function readyCampaigns(
  campaigns: readonly CampaignEntry[],
): CampaignEntry[] {
  return campaigns.filter((campaign) => campaign.status === "active");
}

/** The card a campaign is shaped in, when its chat is a card's. */
export function campaignOwnerCard(
  campaign: CampaignEntry,
  cards: readonly BlogCard[],
): BlogCard | undefined {
  if (!campaign.threadId) return undefined;
  return cards.find((card) => card.threadId === campaign.threadId);
}

/** The cards written for a campaign. */
export function linkedCards(
  campaign: CampaignEntry,
  cards: readonly BlogCard[],
): BlogCard[] {
  return cards.filter((card) => card.campaignId === campaign.id);
}

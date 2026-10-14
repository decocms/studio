/**
 * The closed sets a blog campaign is described by.
 *
 * Shared because both ends validate against them: the editor renders a chip per
 * option, and `BLOG_CAMPAIGN_SUGGEST` narrows what the model returns to the same
 * lists. Restating them server-side would mean a trigger added to one end and
 * silently rejected by the other.
 *
 * The campaign shape itself stays in the web app — it is a decofile block, not a
 * wire contract.
 */

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

/** A target is the slice a campaign argues for — never a single product. */
export const CAMPAIGN_TARGET_KINDS = ["category", "collection"] as const;
export type CampaignTargetKind = (typeof CAMPAIGN_TARGET_KINDS)[number];

/** How many images a campaign keeps per product; the post picks one. */
export const MAX_CAMPAIGN_PRODUCT_IMAGES = 3;

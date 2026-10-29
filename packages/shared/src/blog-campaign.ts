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

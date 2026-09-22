/**
 * Single source of truth for each Studio Pack agent's `title`. Each manager
 * file reads its own title from here instead of duplicating the string, so
 * renaming an agent can't drift out of sync with the combined name list below.
 */
export const STUDIO_PACK_AGENT_TITLES = {
  apiKeyManager: "API Key Manager",
  automationManager: "Automation Manager",
  connectionManager: "Connection Manager",
  storeManager: "Store Manager",
  brandManager: "Brand Manager",
  usageManager: "Usage Manager",
} as const;

/**
 * Human-readable list of Studio Pack agent titles, embedded verbatim in
 * several managers' instructions to tell them apart from user-created agents.
 */
export const STUDIO_PACK_AGENT_NAMES = Object.values(
  STUDIO_PACK_AGENT_TITLES,
).join(", ");

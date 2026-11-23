import type { ChatTier } from "@decocms/shared/organization/schema";
import {
  simpleModeDefaultSlot,
  type SimpleModeDefaults,
} from "@decocms/shared/sdk";
import type { ModelSlot, SimpleModeConfig } from "./use-organization-settings";

export interface ModelTierPreferences {
  tiers: Partial<Record<ChatTier, ModelSlot | null>>;
}

export function firstAvailableModelSlot(
  slots: readonly (ModelSlot | null | undefined)[],
  availableKeyIds: ReadonlySet<string>,
): ModelSlot | null {
  return (
    slots.find(
      (slot): slot is ModelSlot =>
        slot !== null && slot !== undefined && availableKeyIds.has(slot.keyId),
    ) ?? null
  );
}

/**
 * What each tier runs on, in the order `resolveTier` applies: the user's
 * override (chat tiers only), the org slot, then the default pick. A slot is
 * null only when no connected provider has a model for that tier.
 */
export function resolveEffectiveSimpleMode(
  org: SimpleModeConfig,
  user: ModelTierPreferences,
  availableKeyIds: ReadonlySet<string>,
  defaults: SimpleModeDefaults,
): SimpleModeConfig {
  const resolve = (
    tier: keyof SimpleModeConfig["tiers"],
    userSlot?: ModelSlot | null,
  ) =>
    firstAvailableModelSlot(
      [userSlot, org.tiers[tier], simpleModeDefaultSlot(defaults, tier)],
      availableKeyIds,
    );

  return {
    tiers: {
      fast: resolve("fast", user.tiers.fast),
      smart: resolve("smart", user.tiers.smart),
      thinking: resolve("thinking", user.tiers.thinking),
      image: resolve("image"),
      web_search: resolve("web_search"),
      deep_research: resolve("deep_research"),
    },
  };
}

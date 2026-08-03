import type { ChatTier } from "@decocms/shared/organization/schema";
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

export function resolveEffectiveSimpleMode(
  org: SimpleModeConfig,
  user: ModelTierPreferences,
  availableKeyIds: ReadonlySet<string>,
): SimpleModeConfig {
  const liveOrgSlot = (slot: ModelSlot | null) =>
    firstAvailableModelSlot([slot], availableKeyIds);

  return {
    tiers: {
      fast: firstAvailableModelSlot(
        [user.tiers.fast, org.tiers.fast],
        availableKeyIds,
      ),
      smart: firstAvailableModelSlot(
        [user.tiers.smart, org.tiers.smart],
        availableKeyIds,
      ),
      thinking: firstAvailableModelSlot(
        [user.tiers.thinking, org.tiers.thinking],
        availableKeyIds,
      ),
      image: liveOrgSlot(org.tiers.image),
      web_search: liveOrgSlot(org.tiers.web_search),
      deep_research: liveOrgSlot(org.tiers.deep_research),
    },
  };
}

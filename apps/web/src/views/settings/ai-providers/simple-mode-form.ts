import {
  simpleModeDefaultSlot,
  type SimpleModeDefaults,
} from "@decocms/shared/sdk";
import { firstAvailableModelSlot } from "@/hooks/model-slot-resolution";
import type {
  ModelSlot,
  SimpleModeConfig,
  SimpleModeTier,
} from "@/hooks/use-organization-settings";

/**
 * The config to store: the admin's own choices, minus any whose provider key
 * is gone. It takes no defaults, so a tier nobody chose is stored as null and
 * keeps following the default pick.
 */
export function simpleModeToPersist(
  form: SimpleModeConfig,
  availableKeyIds: ReadonlySet<string>,
): SimpleModeConfig {
  const chosen = (slot: ModelSlot | null) =>
    firstAvailableModelSlot([slot], availableKeyIds);

  return {
    tiers: {
      fast: chosen(form.tiers.fast),
      smart: chosen(form.tiers.smart),
      thinking: chosen(form.tiers.thinking),
      image: chosen(form.tiers.image),
      web_search: chosen(form.tiers.web_search),
      deep_research: chosen(form.tiers.deep_research),
    },
  };
}

export interface TierDisplay {
  /** The model the row names; null when no provider has one for the tier. */
  slot: ModelSlot | null;
  /** True when `slot` is today's default pick, not something the admin chose. */
  followsDefault: boolean;
}

/** What a tier row shows: the admin's live choice, or what an unset slot resolves to. */
export function tierDisplay(
  tier: SimpleModeTier,
  stored: ModelSlot | null,
  defaults: SimpleModeDefaults,
  availableKeyIds: ReadonlySet<string>,
): TierDisplay {
  const chosen = firstAvailableModelSlot([stored], availableKeyIds);
  if (chosen) return { slot: chosen, followsDefault: false };
  return { slot: simpleModeDefaultSlot(defaults, tier), followsDefault: true };
}

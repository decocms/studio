import { resolveTierSubtitle } from "./use-agent-mode";
import { TierTriggerPure, tierIconFor } from "./tier-trigger";

export type SimpleModeTier = "fast" | "smart" | "thinking";

/**
 * Tier dropdown used by automations. Same visual treatment as the chat
 * `TierTrigger` (icon + label closed pill; subtitle + check rows in the
 * popover) but with a controlled `tier` / `onSelect` API instead of
 * reading from chat prefs, and locked to the Decopilot intent glyphs
 * + descriptions (automations don't have an AgentMode concept).
 */
export function SimpleModeTierDropdown({
  tier,
  onSelect,
}: {
  tier: SimpleModeTier;
  onSelect: (t: SimpleModeTier) => void;
}) {
  return (
    <TierTriggerPure
      tier={tier}
      subtitleFor={(t) => resolveTierSubtitle("cloud-decopilot", t)}
      iconFor={(t) => tierIconFor("cloud-decopilot", t)}
      onSelect={onSelect}
    />
  );
}

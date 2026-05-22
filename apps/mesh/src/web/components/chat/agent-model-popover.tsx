import type { ChatTier } from "@/tools/organization/schema";
import { AgentSection } from "./select-model/agent-section";
import type {
  AgentKind,
  AgentSection as AgentSectionData,
} from "./select-model/agent-models";

interface Props {
  sections: AgentSectionData[];
  activeAgent: AgentKind | null;
  activeTier: ChatTier;
  onSelect: (agent: AgentKind, tier: ChatTier) => void;
}

/**
 * Tier picker popover. Agent selection now lives outside the popover
 * (see `AgentSegmentedControl`), so this component is purely a 3-row
 * tier list for the currently active agent. Falls back to the first
 * section when `activeAgent` is missing from `sections`.
 */
export function AgentModelPopover({
  sections,
  activeAgent,
  activeTier,
  onSelect,
}: Props) {
  const section =
    sections.find((s) => s.kind === activeAgent) ?? sections[0] ?? null;

  if (!section) {
    return <div className="flex flex-col gap-1 w-60" />;
  }

  const selectedTier = section.kind === activeAgent ? activeTier : null;

  return (
    <div className="flex flex-col gap-1 w-60 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto">
      <AgentSection
        section={section}
        selectedTier={selectedTier}
        disabled={false}
        hideHeader
        onSelect={(tier) => onSelect(section.kind, tier)}
      />
    </div>
  );
}

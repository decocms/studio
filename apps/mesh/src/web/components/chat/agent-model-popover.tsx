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
  /** When non-null, only the section matching this kind is interactive;
   *  the others render opacity-40 + pointer-events-none. */
  lockedAgent: AgentKind | null;
  onSelect: (agent: AgentKind, tier: ChatTier) => void;
}

export function AgentModelPopover({
  sections,
  activeAgent,
  activeTier,
  lockedAgent,
  onSelect,
}: Props) {
  return (
    <div className="flex flex-col gap-1 p-1.5 w-72">
      {sections.map((section) => {
        const disabled = lockedAgent !== null && lockedAgent !== section.kind;
        const selectedTier = activeAgent === section.kind ? activeTier : null;
        return (
          <AgentSection
            key={section.kind}
            section={section}
            selectedTier={selectedTier}
            disabled={disabled}
            onSelect={(tier) => onSelect(section.kind, tier)}
          />
        );
      })}
    </div>
  );
}

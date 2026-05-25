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
  const single = sections.length === 1;
  // Always resolve a default selection so one tier is always highlighted —
  // when activeAgent doesn't match a rendered section, fall back to the
  // first section so the popover never opens with nothing "On".
  const resolvedActiveAgent =
    sections.find((s) => s.kind === activeAgent)?.kind ??
    sections[0]?.kind ??
    null;

  return (
    <div className="flex flex-col gap-1 w-72 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto">
      {sections.map((section) => {
        const disabled = lockedAgent !== null && lockedAgent !== section.kind;
        const selectedTier =
          resolvedActiveAgent === section.kind ? activeTier : null;
        return (
          <AgentSection
            key={section.kind}
            section={section}
            selectedTier={selectedTier}
            disabled={disabled}
            hideHeader={single}
            onSelect={(tier) => onSelect(section.kind, tier)}
          />
        );
      })}
    </div>
  );
}

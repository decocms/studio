import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
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
  /** When non-null, only this section is rendered (no tab bar). */
  lockedAgent: AgentKind | null;
  onSelect: (agent: AgentKind, tier: ChatTier) => void;
}

function resolveDefaultAgent(
  sections: AgentSectionData[],
  activeAgent: AgentKind | null,
): AgentKind | null {
  return (
    sections.find((s) => s.kind === activeAgent)?.kind ??
    sections[0]?.kind ??
    null
  );
}

export function AgentModelPopover({
  sections,
  activeAgent,
  activeTier,
  lockedAgent,
  onSelect,
}: Props) {
  const defaultAgent = resolveDefaultAgent(sections, activeAgent);
  // Initial tab seeds from activeAgent on first mount only; subsequent user
  // tab-switches are sticky for the lifetime of this popover. Each popover
  // open creates a fresh mount, so close/reopen re-seeds from activeAgent.
  const [selectedTab, setSelectedTab] = useState<AgentKind | null>(
    defaultAgent,
  );

  // When lockedAgent is set, force-render only that section (no tabs).
  if (lockedAgent !== null) {
    const lockedSection = sections.find((s) => s.kind === lockedAgent);
    if (!lockedSection) {
      return <div className="flex flex-col gap-1 w-56" />;
    }
    const selectedTier = lockedSection.kind === activeAgent ? activeTier : null;
    return (
      <div className="flex flex-col gap-1 w-56 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto">
        <AgentSection
          section={lockedSection}
          selectedTier={selectedTier}
          disabled={false}
          hideHeader
          onSelect={(tier) => onSelect(lockedSection.kind, tier)}
        />
      </div>
    );
  }

  if (sections.length === 0) {
    return <div className="flex flex-col gap-1 w-56" />;
  }

  // Single-section: no tab bar, just the body.
  if (sections.length === 1) {
    const only = sections[0]!;
    const selectedTier = only.kind === activeAgent ? activeTier : null;
    return (
      <div className="flex flex-col gap-1 w-56 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto">
        <AgentSection
          section={only}
          selectedTier={selectedTier}
          disabled={false}
          hideHeader
          onSelect={(tier) => onSelect(only.kind, tier)}
        />
      </div>
    );
  }

  // Make sure the controlled tab is still in `sections`. If sections changed
  // out from under us (e.g. link went offline), fall back to the default.
  const activeTab =
    sections.find((s) => s.kind === selectedTab)?.kind ?? defaultAgent;
  const activeSection =
    sections.find((s) => s.kind === activeTab) ?? sections[0]!;
  const selectedTier = activeSection.kind === activeAgent ? activeTier : null;

  return (
    <div className="flex flex-col gap-1 w-56 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto">
      <div className="flex items-center gap-1 border-b border-border px-1 pt-1">
        {sections.map((section) => {
          const isActive = section.kind === activeSection.kind;
          return (
            <button
              key={section.kind}
              type="button"
              aria-pressed={isActive}
              onClick={() => setSelectedTab(section.kind)}
              className={cn(
                "flex items-center gap-1.5 rounded-t-md px-2 py-1.5 text-xs font-medium",
                isActive
                  ? "text-foreground border-b-2 border-foreground -mb-px"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {section.isLocal && (
                <span
                  data-testid="local-indicator"
                  className="size-1.5 rounded-full bg-success"
                />
              )}
              <span>{section.title}</span>
              {section.isLocal && <span className="sr-only">on desktop</span>}
            </button>
          );
        })}
      </div>
      <AgentSection
        key={activeSection.kind}
        section={activeSection}
        selectedTier={selectedTier}
        disabled={false}
        hideHeader
        onSelect={(tier) => onSelect(activeSection.kind, tier)}
      />
    </div>
  );
}

import { cn } from "@deco/ui/lib/utils.ts";
import type { HarnessId } from "@/harnesses";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import type { ChatTier } from "@/tools/organization/schema";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { track } from "@/web/lib/posthog-client";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { useCurrentLink } from "@/web/hooks/use-current-link";
import { useVmStart } from "@/web/components/vm/hooks/use-vm-start";
import { useChatPrefs } from "./context";
import {
  type AgentKind,
  type AgentSection as AgentSectionData,
  getAgentSections,
} from "./select-model/agent-models";
import { agentKindFromHarness, optionForAgent } from "./agent-model-trigger";

interface Props {
  agent: HarnessId | null;
  sandboxKind: SandboxProviderKind | null;
  tier: ChatTier;
  /** Set when the user is on a branch — needed for the eager VM-start
   *  when the user picks a CLI agent. `null` when no branch is selected
   *  (no eager start). */
  currentBranch: string | null;
  virtualMcpId: string;
}

/**
 * Always-visible segmented control that lets the user pick the active
 * agent (Decopilot / Claude Code / Codex). Sits to the left of
 * `AgentModelTrigger` in the chat input. Hidden entirely when the
 * current agent is not clonable, or when fewer than two sections are
 * eligible (no choice to make).
 */
export function AgentSegmentedControl({
  agent,
  sandboxKind,
  tier,
  currentBranch,
  virtualMcpId,
}: Props) {
  const keys = useAiProviderKeys();
  const link = useCurrentLink();
  const { setPendingAgentOption, isAgentClonable } = useChatPrefs();
  const { org } = useProjectContext();
  const mcpClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const startVm = useVmStart(mcpClient);

  const sections = getAgentSections({
    hasAnyKey: keys.length > 0,
    link,
  });

  if (!isAgentClonable || sections.length <= 1) {
    return null;
  }

  const activeAgent = agentKindFromHarness(agent, sandboxKind);

  const handleSelect = (kind: AgentKind) => {
    setPendingAgentOption(optionForAgent(kind));
    if (kind !== "decopilot" && currentBranch) {
      startVm.mutate({
        virtualMcpId,
        branch: currentBranch,
        sandboxProviderKind: "remote-user" as const,
      });
    }
    track("agent_model_selected", { agent: kind, tier });
  };

  return (
    <AgentSegmentedControlPure
      sections={sections}
      activeAgent={activeAgent}
      onSelect={handleSelect}
    />
  );
}

interface PureProps {
  sections: AgentSectionData[];
  activeAgent: AgentKind | null;
  onSelect: (kind: AgentKind) => void;
}

/**
 * Stateless segmented-control variant for tests. Renders the buttons
 * inline; consumers wire up persistence + analytics in the wrapper.
 */
export function AgentSegmentedControlPure({
  sections,
  activeAgent,
  onSelect,
}: PureProps) {
  return (
    <div className="inline-flex items-center rounded-md bg-muted p-0.5">
      {sections.map((section) => {
        const isActive = section.kind === activeAgent;
        return (
          <button
            key={section.kind}
            type="button"
            aria-pressed={isActive}
            onClick={() => onSelect(section.kind)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors",
              isActive
                ? "bg-background text-foreground shadow-sm"
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
  );
}

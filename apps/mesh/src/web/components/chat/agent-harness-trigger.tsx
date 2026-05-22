import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useState } from "react";
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
 * Pill + popover that lets the user pick the active harness
 * (Decopilot / Claude Code / Codex). Sits to the left of
 * `AgentModelTrigger` in the chat input. Hidden entirely when the
 * current agent is not clonable, or when fewer than two sections are
 * eligible (no choice to make).
 */
export function AgentHarnessTrigger({
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
    <AgentHarnessTriggerPure
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
 * Stateless variant for tests. Renders the closed pill + popover —
 * does not touch hooks or chat prefs.
 */
export function AgentHarnessTriggerPure({
  sections,
  activeAgent,
  onSelect,
}: PureProps) {
  const [open, setOpen] = useState(false);

  const section =
    sections.find((s) => s.kind === activeAgent) ?? sections[0] ?? null;

  if (!section) return null;

  const isLocalActive = section.isLocal;

  const baseClasses =
    "gap-0 @[496px]/chat-bottom:gap-1.5 text-muted-foreground hover:text-foreground";
  const localActiveClasses = isLocalActive
    ? "text-success bg-success/10 hover:text-success"
    : "";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="default"
          title={section.title}
          aria-label={section.title}
          className={cn(baseClasses, localActiveClasses)}
        >
          {section.isLocal && (
            <span
              data-testid="harness-local-indicator"
              className="size-1.5 shrink-0 rounded-full bg-success"
            />
          )}
          <span className="inline-block overflow-hidden whitespace-nowrap max-w-0 opacity-0 transition-[max-width,opacity] duration-200 ease-out @[496px]/chat-bottom:max-w-32 @[496px]/chat-bottom:opacity-100">
            {section.title}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-0 w-auto">
        <div className="flex flex-col gap-0.5 p-1 w-56">
          {sections.map((s) => {
            const isActive = s.kind === activeAgent;
            return (
              <button
                key={s.kind}
                type="button"
                aria-pressed={isActive}
                onClick={() => {
                  onSelect(s.kind);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-2.5 text-left text-sm hover:bg-accent",
                  isActive && "bg-accent",
                )}
              >
                {s.isLocal && (
                  <span
                    data-testid="harness-local-indicator"
                    className="size-1.5 shrink-0 rounded-full bg-success"
                  />
                )}
                <span className="text-sm leading-tight truncate">
                  {s.title}
                </span>
                {s.isLocal && <span className="sr-only">on desktop</span>}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

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
import { AgentModelPopover } from "./agent-model-popover";
import {
  type AgentKind,
  type AgentSection,
  getAgentSections,
} from "./select-model/agent-models";

interface Props {
  agent: HarnessId | null;
  sandboxKind: SandboxProviderKind | null;
  tier: ChatTier;
  /** Set when the user is on a branch — needed for the eager VM-start
   *  when the user picks a CLI agent. `null` when no branch is selected
   *  (no eager start). */
  currentBranch: string | null;
  virtualMcpId: string;
  /** Tier-only setter — kept for callers that want to swap tier without
   *  also potentially flipping agents (the popover handles agent +
   *  tier itself via `setPendingAgentOption`). */
  onSelect: (tier: ChatTier) => void;
}

/** Maps the popover's AgentKind back to the persisted AgentOption. */
function optionForAgent(kind: AgentKind) {
  switch (kind) {
    case "decopilot":
      return "decopilot" as const;
    case "claude-code":
      return "claude-code-desktop" as const;
    case "codex":
      return "codex-desktop" as const;
  }
}

function agentKindFromHarness(
  agent: HarnessId | null,
  sandboxKind: SandboxProviderKind | null,
): AgentKind | null {
  if (agent === "claude-code" && sandboxKind === "desktop")
    return "claude-code";
  if (agent === "codex" && sandboxKind === "desktop") return "codex";
  if (agent === "decopilot") return "decopilot";
  return null;
}

/**
 * Trigger pill in the chat input that opens the merged sectioned
 * popover (Decopilot + Claude Code + Codex). When the active agent is
 * a desktop-CLI variant the pill turns `text-success` + `bg-success/10`
 * to mirror the "Desktop connected" affordance in
 * `NoAiProviderEmptyState`. The popover handles agent + tier writes
 * atomically.
 */
export function AgentModelTrigger({
  agent,
  sandboxKind,
  tier,
  currentBranch,
  virtualMcpId,
  onSelect,
}: Props) {
  const keys = useAiProviderKeys();
  const link = useCurrentLink();
  const { setPendingAgentOption } = useChatPrefs();
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

  const activeAgent = agentKindFromHarness(agent, sandboxKind);

  const handleSelect = (kind: AgentKind, nextTier: ChatTier) => {
    const opt = optionForAgent(kind);
    setPendingAgentOption(opt);
    onSelect(nextTier);
    if (kind !== "decopilot" && currentBranch) {
      startVm.mutate({
        virtualMcpId,
        branch: currentBranch,
        sandboxProviderKind: "desktop" as const,
      });
    }
    track("agent_model_selected", { agent: kind, tier: nextTier });
  };

  return (
    <AgentModelTriggerPure
      sections={sections}
      activeAgent={activeAgent}
      activeTier={tier}
      lockedAgent={null /* lock comes from caller via ThreadPills later */}
      onSelect={handleSelect}
    />
  );
}

interface PureProps {
  sections: AgentSection[];
  activeAgent: AgentKind | null;
  activeTier: ChatTier;
  lockedAgent: AgentKind | null;
  onSelect: (kind: AgentKind, tier: ChatTier) => void;
}

/**
 * Stateless variant for tests. Renders the closed pill + popover —
 * does not touch hooks or chat prefs. Keeps `AgentModelTrigger`
 * thin so test cases don't have to mock the entire chat context.
 */
export function AgentModelTriggerPure({
  sections,
  activeAgent,
  activeTier,
  lockedAgent,
  onSelect,
}: PureProps) {
  const [open, setOpen] = useState(false);

  const section =
    sections.find((s) => s.kind === activeAgent) ?? sections[0] ?? null;
  const tierEntry = section?.tiers[activeTier];

  const isLocalActive = section?.isLocal ?? false;
  const label = tierEntry?.label ?? "";

  // Closed pill — collapses label at narrow widths; `gap-0` on the
  // outer + `@[496px]/chat-bottom:gap-1.5` keeps the icon + chevron
  // flush when the label is hidden.
  const baseClasses =
    "gap-0 @[496px]/chat-bottom:gap-1.5 text-muted-foreground hover:text-foreground";
  const localActiveClasses = isLocalActive
    ? "text-success bg-success/10 hover:text-success"
    : "";

  if (!section || !tierEntry) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="default"
          title={label}
          aria-label={label}
          className={cn(baseClasses, localActiveClasses)}
        >
          {tierEntry.iconNode ? (
            <span className="size-4 inline-flex items-center justify-center">
              {tierEntry.iconNode}
            </span>
          ) : tierEntry.iconUrl ? (
            <img
              src={tierEntry.iconUrl}
              alt=""
              className="size-4 rounded-sm dark:bg-white dark:rounded-sm dark:p-px"
            />
          ) : null}
          <span className="inline-block overflow-hidden whitespace-nowrap max-w-0 opacity-0 transition-[max-width,opacity] duration-200 ease-out @[496px]/chat-bottom:max-w-32 @[496px]/chat-bottom:opacity-100">
            {label}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-0">
        <AgentModelPopover
          sections={sections}
          activeAgent={activeAgent}
          activeTier={activeTier}
          lockedAgent={lockedAgent}
          onSelect={(kind, t) => {
            onSelect(kind, t);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

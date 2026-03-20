/**
 * Agents List Component for Home Page
 *
 * Displays a compact list of agents (Virtual MCPs) with their icon and name.
 * Only shows when the organization has agents.
 */

import { useChatStable } from "@/web/components/chat/context";
import {
  VirtualMCPPopoverContent,
  type VirtualMCPInfo,
} from "@/web/components/chat/select-virtual-mcp";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  isDecopilot,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import { readRecentAgentIds } from "@/web/components/chat/store/local-storage";
import { ChevronRight, Plus, Users03 } from "@untitledui/icons";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { SiteEditorOnboardingModal } from "@/web/components/home/site-editor-onboarding-modal.tsx";
import { useCreateVirtualMCP } from "@/web/hooks/use-create-virtual-mcp";
import { Suspense, useEffect, useRef, useState } from "react";

/**
 * Individual agent preview component
 */
function AgentPreview({
  agent,
  onSpecialClick,
}: {
  agent: {
    id: string;
    title: string;
    icon?: string | null;
  };
  onSpecialClick?: () => void;
}) {
  const { setVirtualMcpId } = useChatStable();

  const handleClick = () => {
    if (onSpecialClick) {
      onSpecialClick();
    } else {
      setVirtualMcpId(agent.id);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "flex flex-col items-center gap-3 p-2 rounded-lg",
        "transition-colors",
        "cursor-pointer",
        "w-[88px]",
        "group",
      )}
      aria-label={`Select agent ${agent.title}`}
    >
      <IntegrationIcon
        icon={agent.icon}
        name={agent.title}
        size="md"
        fallbackIcon={<Users03 size={24} />}
        className="transition-transform group-hover:scale-110"
      />
      <p className="text-xs sm:text-sm text-foreground text-center leading-tight line-clamp-2">
        {agent.title}
      </p>
    </button>
  );
}

/**
 * See All button component
 */
function SeeAllButton({
  virtualMcps,
  selectedVirtualMcpId,
  onVirtualMcpChange,
}: {
  virtualMcps: VirtualMCPInfo[];
  selectedVirtualMcpId?: string | null;
  onVirtualMcpChange: (virtualMcpId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  // Focus search input when popover opens (skip on mobile to avoid keyboard popup)
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (open && !isMobile) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
    }
  }, [open, isMobile]);

  const handleVirtualMcpChange = (virtualMcpId: string | null) => {
    onVirtualMcpChange(virtualMcpId);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex flex-col items-center gap-3 p-2 rounded-lg",
            "transition-colors",
            "cursor-pointer",
            "w-[88px]",
            "group",
          )}
          aria-label="See all agents"
        >
          <div className="size-12 rounded-xl bg-accent flex items-center justify-center shrink-0 transition-transform group-hover:scale-110">
            <ChevronRight size={20} className="text-foreground" />
          </div>
          <p className="text-xs sm:text-sm text-foreground text-center leading-tight">
            See all
          </p>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[550px] p-0 overflow-hidden"
        align="start"
        side="top"
        sideOffset={8}
      >
        <VirtualMCPPopoverContent
          virtualMcps={virtualMcps}
          selectedVirtualMcpId={selectedVirtualMcpId}
          onVirtualMcpChange={handleVirtualMcpChange}
          searchInputRef={searchInputRef}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Hardcoded Site Editor agent shown first in the agents list for onboarding.
 */
const SITE_EDITOR_AGENT = {
  id: "site-editor",
  title: "Site Editor",
  icon: "icon://Globe01?color=violet",
} as const;

/**
 * Agents list content component
 */
function CreateAgentButton() {
  const { createVirtualMCP, isCreating } = useCreateVirtualMCP({
    navigateOnCreate: true,
  });

  return (
    <button
      type="button"
      onClick={() => createVirtualMCP()}
      disabled={isCreating}
      className={cn(
        "flex flex-col items-center gap-3 p-2 rounded-lg",
        "transition-colors",
        "cursor-pointer",
        "w-[88px]",
        "group",
        "disabled:opacity-50 disabled:cursor-not-allowed",
      )}
      aria-label="Create agent"
    >
      <div className="size-12 rounded-xl bg-background border-2 border-dashed border-border flex items-center justify-center shrink-0 transition-transform group-hover:scale-110">
        <Plus size={20} className="text-muted-foreground" />
      </div>
      <p className="text-xs sm:text-sm text-foreground text-center leading-tight">
        Create agent
      </p>
    </button>
  );
}

function AgentsListContent() {
  const virtualMcps = useVirtualMCPs();
  const { selectedVirtualMcp, setVirtualMcpId } = useChatStable();
  const { locator } = useProjectContext();
  const [siteEditorModalOpen, setSiteEditorModalOpen] = useState(false);

  const recentIds = readRecentAgentIds(locator);

  // Filter out Decopilot, sort by most recently used (from localStorage), then take top 5
  const agents = virtualMcps
    .filter(
      (agent): agent is typeof agent & { id: string } =>
        agent.id !== null && !isDecopilot(agent.id),
    )
    .sort((a, b) => {
      const aIdx = recentIds.indexOf(a.id);
      const bIdx = recentIds.indexOf(b.id);
      // Both in recents: lower index = more recent
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      // Only a in recents: a comes first
      if (aIdx !== -1) return -1;
      // Only b in recents: b comes first
      if (bIdx !== -1) return 1;
      // Neither in recents: fall back to most recently updated
      return (
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
    })
    .slice(0, 5);

  // Convert to VirtualMCPInfo format
  const virtualMcpsInfo: VirtualMCPInfo[] = virtualMcps.map((agent) => ({
    id: agent.id,
    title: agent.title,
    description: agent.description,
    icon: agent.icon,
  }));

  const hasAgents = agents.length > 0;

  return (
    <>
      <div className="w-full">
        <div className="flex flex-wrap justify-center gap-2">
          <AgentPreview
            key={SITE_EDITOR_AGENT.id}
            agent={SITE_EDITOR_AGENT}
            onSpecialClick={() => setSiteEditorModalOpen(true)}
          />
          {agents.map((agent) => (
            <AgentPreview key={agent.id ?? "default"} agent={agent} />
          ))}
          <CreateAgentButton />
          {hasAgents && (
            <SeeAllButton
              virtualMcps={virtualMcpsInfo}
              selectedVirtualMcpId={selectedVirtualMcp?.id ?? null}
              onVirtualMcpChange={setVirtualMcpId}
            />
          )}
        </div>
      </div>

      <SiteEditorOnboardingModal
        open={siteEditorModalOpen}
        onOpenChange={setSiteEditorModalOpen}
      />
    </>
  );
}

/**
 * Skeleton loader for agents list
 */
function AgentsListSkeleton() {
  return (
    <div className="w-full">
      <div className="flex flex-wrap justify-center gap-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col items-center gap-3 p-2 w-[88px]"
          >
            <Skeleton className="size-12 rounded-xl shrink-0" />
            <Skeleton className="h-3 sm:h-4 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Agents list component with Suspense boundary
 */
export function AgentsList() {
  return (
    <Suspense fallback={<AgentsListSkeleton />}>
      <AgentsListContent />
    </Suspense>
  );
}

/**
 * Agents List Component for Home Page
 *
 * Displays a compact list of agents (Virtual MCPs) with their icon and name.
 * Only shows when the organization has agents.
 */

import { useChatPrefs } from "@/web/components/chat/context";
import { VirtualMCPPopoverContent } from "@/web/components/chat/select-virtual-mcp";
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
import type { ProjectLocator } from "@decocms/mesh-sdk";

function readRecentAgentIds(locator: ProjectLocator): string[] {
  try {
    const raw = localStorage.getItem(`mesh:chat:recent-agents:${locator}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, Plus, Users03 } from "@untitledui/icons";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { SiteEditorOnboardingModal } from "@/web/components/home/site-editor-onboarding-modal.tsx";
import { SiteDiagnosticsRecruitModal } from "@/web/components/home/site-diagnostics-recruit-modal.tsx";
import { useCreateVirtualMCP } from "@/web/hooks/use-create-virtual-mcp";
import { usePinnedAgents } from "@/web/hooks/use-pinned-agents";
import { Suspense, useRef, useState } from "react";

/**
 * Individual agent preview component
 */
function AgentPreview({
  agent,
  onSpecialClick,
  onPin,
}: {
  agent: {
    id: string;
    title: string;
    icon?: string | null;
  };
  onSpecialClick?: () => void;
  onPin?: (id: string) => void;
}) {
  const { org } = useProjectContext();
  const navigate = useNavigate();

  const handleClick = () => {
    if (onSpecialClick) {
      onSpecialClick();
    } else {
      onPin?.(agent.id);
      navigate({
        to: "/$org/$virtualMcpId",
        params: { org: org.slug, virtualMcpId: agent.id },
      });
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
        "w-[88px] shrink-0",
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
  selectedVirtualMcpId,
  onVirtualMcpChange,
}: {
  selectedVirtualMcpId?: string | null;
  onVirtualMcpChange: (virtualMcpId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

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
            "w-[88px] shrink-0",
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
        onOpenAutoFocus={(e) => {
          if (!isMobile) {
            e.preventDefault();
            searchInputRef.current?.focus();
          }
        }}
      >
        <VirtualMCPPopoverContent
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

const SITE_DIAGNOSTICS_AGENT = {
  id: "site-diagnostics",
  title: "Site Diagnostics",
  icon: "icon://SearchRefraction?color=cyan",
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
        "w-[88px] shrink-0",
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
  const { selectedVirtualMcp, setVirtualMcpId } = useChatPrefs();
  const { locator, org } = useProjectContext();
  const [siteEditorModalOpen, setSiteEditorModalOpen] = useState(false);
  const serverPinnedIds = virtualMcps
    .filter((a): a is typeof a & { id: string } => a.id !== null && !!a.pinned)
    .map((a) => a.id);
  const { pin } = usePinnedAgents(org.id, serverPinnedIds);
  const [diagnosticsModalOpen, setDiagnosticsModalOpen] = useState(false);

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

  // Check if Site Diagnostics agent already exists (already recruited)
  const hasDiagnostics = agents.some(
    (a) =>
      a.title === "Site Diagnostics" ||
      (a as { metadata?: { type?: string } }).metadata?.type ===
        "site-diagnostics",
  );

  const hasAgents = agents.length > 0;

  return (
    <>
      <div className="w-full">
        <div className="flex flex-wrap justify-center gap-2 max-md:overflow-x-auto max-md:flex-nowrap max-md:justify-start max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden">
          <AgentPreview
            key={SITE_EDITOR_AGENT.id}
            agent={SITE_EDITOR_AGENT}
            onSpecialClick={() => setSiteEditorModalOpen(true)}
          />
          {!hasDiagnostics && (
            <AgentPreview
              key={SITE_DIAGNOSTICS_AGENT.id}
              agent={SITE_DIAGNOSTICS_AGENT}
              onSpecialClick={() => setDiagnosticsModalOpen(true)}
            />
          )}
          {agents.map((agent) => (
            <AgentPreview
              key={agent.id ?? "default"}
              agent={agent}
              onPin={pin}
            />
          ))}
          <CreateAgentButton />
          {hasAgents && (
            <SeeAllButton
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

      <SiteDiagnosticsRecruitModal
        open={diagnosticsModalOpen}
        onOpenChange={setDiagnosticsModalOpen}
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
      <div className="flex flex-wrap justify-center gap-2 max-md:overflow-x-auto max-md:flex-nowrap max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col items-center gap-3 p-2 w-[88px] shrink-0"
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

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
import { isDecopilot, useVirtualMCPs } from "@decocms/mesh-sdk";
import { ChevronRight, Users03 } from "@untitledui/icons";
import { Suspense, useEffect, useRef, useState } from "react";

/**
 * Individual agent preview component
 */
function AgentPreview({
  agent,
}: {
  agent: {
    id: string;
    title: string;
    icon?: string | null;
  };
}) {
  const { setVirtualMcpId } = useChatStable();

  const handleClick = () => {
    // Select the agent in the chat context
    setVirtualMcpId(agent.id);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "flex flex-col items-center gap-3 p-2 rounded-lg",
        "transition-colors hover:bg-accent/30",
        "cursor-pointer",
        "self-stretch",
      )}
      aria-label={`Select agent ${agent.title}`}
    >
      <IntegrationIcon
        icon={agent.icon}
        name={agent.title}
        fallbackIcon={<Users03 size={20} />}
      />
      <p className="text-sm text-foreground text-center leading-tight line-clamp-2">
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

  // Focus search input when popover opens
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
    }
  }, [open]);

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
            "transition-colors hover:bg-accent/30",
            "cursor-pointer",
            "self-stretch",
          )}
          aria-label="See all agents"
        >
          <div className="size-12 rounded-lg bg-accent flex items-center justify-center shrink-0">
            <ChevronRight size={24} className="text-foreground" />
          </div>
          <p className="text-sm text-foreground text-center leading-tight">
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
 * Agents list content component
 */
function AgentsListContent() {
  const virtualMcps = useVirtualMCPs();
  const { selectedVirtualMcp, setVirtualMcpId } = useChatStable();

  // Filter out the default Decopilot agent (it's not a real agent)
  const agents = virtualMcps
    .filter(
      (agent): agent is typeof agent & { id: string } =>
        agent.id !== null && !isDecopilot(agent.id),
    )
    .slice(0, 6);

  // Don't render if no agents
  if (agents.length === 0) {
    return null;
  }

  // Convert to VirtualMCPInfo format
  const virtualMcpsInfo: VirtualMCPInfo[] = virtualMcps.map((agent) => ({
    id: agent.id,
    title: agent.title,
    description: agent.description,
    icon: agent.icon,
  }));

  return (
    <div className="w-full max-w-[800px]">
      <h2 className="text-sm font-medium text-muted-foreground mb-4">
        Recently used agents
      </h2>
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-7 gap-2">
        {agents.map((agent) => (
          <AgentPreview key={agent.id ?? "default"} agent={agent} />
        ))}
        <SeeAllButton
          virtualMcps={virtualMcpsInfo}
          selectedVirtualMcpId={selectedVirtualMcp?.id ?? null}
          onVirtualMcpChange={setVirtualMcpId}
        />
      </div>
    </div>
  );
}

/**
 * Skeleton loader for agents list
 */
function AgentsListSkeleton() {
  return (
    <div className="w-full max-w-[800px]">
      <Skeleton className="h-5 w-40 mb-4" />
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-7 gap-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col items-center gap-3 p-2 self-stretch"
          >
            <Skeleton className="size-6 rounded-md shrink-0" />
            <Skeleton className="h-4 w-full" />
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

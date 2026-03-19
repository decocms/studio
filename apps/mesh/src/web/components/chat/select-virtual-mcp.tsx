import { AgentAvatar } from "@/web/components/agent-icon";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  isDecopilot,
  useVirtualMCPs,
  type VirtualMCPEntity,
} from "@decocms/mesh-sdk";
import { Check, SearchMd, Users03 } from "@untitledui/icons";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { useCreateVirtualMCP } from "../../hooks/use-create-virtual-mcp";

export interface VirtualMCPInfo
  extends Omit<
    Pick<VirtualMCPEntity, "id" | "title" | "description" | "icon">,
    "id"
  > {
  id: string | null;
  fallbackIcon?: ReactNode; // Icon to use when icon is not available
}

function VirtualMCPItemContent({
  virtualMcp,
  isSelected,
}: {
  virtualMcp: VirtualMCPInfo;
  isSelected?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 py-3 px-3 hover:bg-accent cursor-pointer rounded-xl transition-colors",
        isSelected && "bg-accent",
      )}
    >
      {/* Icon */}
      <AgentAvatar icon={virtualMcp.icon} name={virtualMcp.title} size="sm" />

      {/* Text Content */}
      <div className="flex flex-col flex-1 min-w-0 gap-0.5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground truncate">
            {virtualMcp.title}
          </span>
          {isSelected && (
            <Check size={16} className="text-foreground shrink-0" />
          )}
        </div>
        {virtualMcp.description && (
          <p className="text-xs text-muted-foreground line-clamp-1 leading-relaxed">
            {virtualMcp.description}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- Shared Popover Content ----------

export interface VirtualMCPPopoverContentProps {
  virtualMcps: VirtualMCPInfo[];
  selectedVirtualMcpId?: string | null;
  onVirtualMcpChange: (virtualMcpId: string | null) => void;
  searchInputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * Shared popover content for virtual MCP (agent) selection.
 * Contains search input and virtual MCP grid.
 * Used by both VirtualMCPSelector and VirtualMCPBadge.
 */
export function VirtualMCPPopoverContent({
  virtualMcps,
  selectedVirtualMcpId,
  onVirtualMcpChange,
  searchInputRef,
}: VirtualMCPPopoverContentProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = searchInputRef ?? internalRef;
  const { createVirtualMCP, isCreating } = useCreateVirtualMCP({
    navigateOnCreate: true,
  });

  // Filter virtual MCPs based on search term and exclude Decopilot
  const filteredVirtualMcps = (() => {
    // First filter out Decopilot
    const nonDecopilotMcps = virtualMcps.filter(
      (virtualMcp) => !virtualMcp.id || !isDecopilot(virtualMcp.id),
    );

    if (!searchTerm.trim()) return nonDecopilotMcps;

    const search = searchTerm.toLowerCase();
    return nonDecopilotMcps.filter((virtualMcp) => {
      return (
        virtualMcp.title.toLowerCase().includes(search) ||
        virtualMcp.description?.toLowerCase().includes(search)
      );
    });
  })();

  const handleSelect = (virtualMcpId: string | null) => {
    onVirtualMcpChange(virtualMcpId);
    setSearchTerm("");
  };

  return (
    <div className="flex flex-col max-h-[min(400px,60dvh)]">
      {/* Search input */}
      <div className="border-b px-4 py-3 bg-background/95 backdrop-blur sticky top-0 z-10">
        <div className="relative flex items-center gap-2">
          <SearchMd
            size={16}
            className="text-muted-foreground pointer-events-none shrink-0"
          />
          <Input
            ref={inputRef}
            type="text"
            placeholder="Search for an agent..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="flex-1 h-8 text-sm border-0 focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none p-0"
          />
          <Button
            onClick={createVirtualMCP}
            variant="outline"
            size="sm"
            className="h-8 px-3 rounded-lg text-sm font-medium shrink-0"
            disabled={isCreating}
          >
            {isCreating ? "Creating..." : "Create Agent"}
          </Button>
        </div>
      </div>

      {/* Virtual MCP grid */}
      <div className="overflow-y-auto p-1.5 flex-1 min-h-0 [touch-action:pan-y]">
        {filteredVirtualMcps.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-0.5">
            {filteredVirtualMcps.map((virtualMcp) => (
              <div
                key={virtualMcp.id}
                role="button"
                tabIndex={0}
                onClick={() => handleSelect(virtualMcp.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleSelect(virtualMcp.id);
                  }
                }}
                className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-xl"
              >
                <VirtualMCPItemContent
                  virtualMcp={virtualMcp}
                  isSelected={virtualMcp.id === selectedVirtualMcpId}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            No agents found
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Virtual MCP Selector Component ----------

export interface VirtualMCPSelectorProps {
  selectedVirtualMcpId?: string | null;
  onVirtualMcpChange: (virtualMcpId: string | null) => void;
  virtualMcps?: VirtualMCPInfo[];
  variant?: "borderless" | "bordered";
  className?: string;
  placeholder?: string;
  showTooltip?: boolean;
  disabled?: boolean;
}

/**
 * Virtual MCP (agent) selector with icon button trigger and tooltip.
 * Opens a popover with searchable virtual MCP list.
 * Used when no virtual MCP is selected (null/default state).
 */
export function VirtualMCPSelector({
  selectedVirtualMcpId,
  onVirtualMcpChange,
  virtualMcps: virtualMcpsProp,
  variant: _variant,
  className,
  placeholder = "Select Agent",
  showTooltip = true,
  disabled = false,
}: VirtualMCPSelectorProps) {
  const [open, setOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Use provided virtual MCPs or fetch from hook
  const virtualMcpsFromHook = useVirtualMCPs();
  const allVirtualMcps = virtualMcpsProp ?? virtualMcpsFromHook;

  // Filter out Decopilot from the list
  const virtualMcps = allVirtualMcps.filter(
    (virtualMcp) => !virtualMcp.id || !isDecopilot(virtualMcp.id),
  );

  const selectedVirtualMcp = selectedVirtualMcpId
    ? allVirtualMcps.find((g) => g.id === selectedVirtualMcpId)
    : null;

  const handleVirtualMcpChange = (virtualMcpId: string | null) => {
    onVirtualMcpChange(virtualMcpId);
    setOpen(false);
  };

  const isMobile = useIsMobile();

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
  };

  // Focus search input when dialog opens (skip on mobile to avoid keyboard popup)
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (open && !isMobile) {
      // Small delay to ensure the dialog is fully rendered
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
    }
  }, [open, isMobile]);

  return (
    <Popover
      open={disabled ? false : open}
      onOpenChange={disabled ? undefined : handleOpenChange}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                className={cn(
                  "relative flex items-center justify-center size-8 rounded-lg text-muted-foreground/75 transition-colors shrink-0",
                  disabled
                    ? "cursor-not-allowed opacity-50"
                    : "cursor-pointer hover:text-muted-foreground",
                  className,
                )}
                aria-label={placeholder}
              >
                {selectedVirtualMcp ? (
                  <AgentAvatar
                    icon={selectedVirtualMcp.icon}
                    name={selectedVirtualMcp.title}
                    size="sm"
                    className="absolute inset-0 size-full"
                  />
                ) : (
                  <>
                    <svg className="absolute inset-0 size-full" fill="none">
                      <defs>
                        <linearGradient
                          id="agent-border-gradient"
                          gradientUnits="userSpaceOnUse"
                          x1="0"
                          y1="0"
                          x2="32"
                          y2="32"
                        >
                          <animateTransform
                            attributeName="gradientTransform"
                            type="rotate"
                            from="0 16 16"
                            to="360 16 16"
                            dur="6s"
                            repeatCount="indefinite"
                          />
                          <stop offset="0%" stopColor="var(--chart-1)" />
                          <stop offset="100%" stopColor="var(--chart-4)" />
                        </linearGradient>
                      </defs>
                      <rect
                        x="0.5"
                        y="0.5"
                        width="31"
                        height="31"
                        rx="7.5"
                        stroke="url(#agent-border-gradient)"
                        strokeWidth="1"
                        strokeDasharray="3 3"
                      />
                    </svg>
                    <Users03 size={16} />
                  </>
                )}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          {showTooltip && !open && (
            <TooltipContent side="top" className="text-xs">
              {selectedVirtualMcp?.title ?? "Choose an agent to chat with"}
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        className="w-[min(550px,calc(100vw-2rem))] p-0 overflow-hidden"
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={16}
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

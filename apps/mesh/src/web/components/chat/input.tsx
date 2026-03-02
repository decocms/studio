import { calculateUsageStats } from "@/web/lib/usage-utils.ts";
import { getAgentColor } from "@/web/utils/agent-color";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  getWellKnownDecopilotVirtualMCP,
  isDecopilot,
  ORG_ADMIN_PROJECT_SLUG,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUp,
  ChevronDown,
  Edit01,
  Stop,
  Users03,
  XCircle,
} from "@untitledui/icons";
import type { FormEvent } from "react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { Metadata } from "./types.ts";
import { useChat } from "./context";
import { ChatHighlight } from "./highlight";
import { ModeSelector } from "./select-mode";
import { ModelSelector } from "./select-model";
import {
  VirtualMCPPopoverContent,
  VirtualMCPSelector,
  type VirtualMCPInfo,
} from "./select-virtual-mcp";
import { FileUploadButton } from "./tiptap/file";
import {
  TiptapInput,
  TiptapProvider,
  type TiptapInputHandle,
} from "./tiptap/input";
import { isTiptapDocEmpty } from "./tiptap/utils";
import { SessionStats } from "./usage-stats";

// ============================================================================
// DecopilotIconButton - Icon button for Decopilot (similar to FileUploadButton)
// ============================================================================

interface DecopilotIconButtonProps {
  onVirtualMcpChange: (virtualMcpId: string | null) => void;
  virtualMcps: VirtualMCPInfo[];
  disabled?: boolean;
}

function DecopilotIconButton({
  onVirtualMcpChange,
  virtualMcps,
  disabled = false,
}: DecopilotIconButtonProps) {
  const [open, setOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { org } = useProjectContext();

  const decopilot = getWellKnownDecopilotVirtualMCP(org.id);

  // Filter out Decopilot from the list
  const filteredVirtualMcps = virtualMcps.filter(
    (virtualMcp) => !virtualMcp.id || !isDecopilot(virtualMcp.id),
  );

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
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "relative flex items-center justify-center size-8 rounded-md text-muted-foreground/75 transition-colors shrink-0",
                disabled
                  ? "cursor-not-allowed opacity-50"
                  : "cursor-pointer hover:text-muted-foreground",
              )}
              disabled={disabled}
            >
              <svg className="absolute inset-0 size-full" fill="none">
                <defs>
                  <linearGradient
                    id="agent-border-gradient-decopilot"
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
                  rx="5.5"
                  stroke="url(#agent-border-gradient-decopilot)"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                />
              </svg>
              <Users03 size={16} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        {!open && <TooltipContent side="top">Decopilot</TooltipContent>}
      </Tooltip>
      <PopoverContent
        className="w-[550px] p-0 overflow-hidden"
        align="start"
        side="top"
        sideOffset={8}
      >
        <VirtualMCPPopoverContent
          virtualMcps={filteredVirtualMcps}
          selectedVirtualMcpId={decopilot.id}
          onVirtualMcpChange={handleVirtualMcpChange}
          searchInputRef={searchInputRef}
        />
      </PopoverContent>
    </Popover>
  );
}

// ============================================================================
// VirtualMCPBadge - Internal component for displaying selected virtual MCP
// ============================================================================

interface VirtualMCPBadgeProps {
  virtualMcpId: string;
  virtualMcps: VirtualMCPInfo[];
  onVirtualMcpChange: (virtualMcpId: string | null) => void;
  disabled?: boolean;
}

function VirtualMCPBadge({
  virtualMcpId,
  virtualMcps,
  onVirtualMcpChange,
  disabled = false,
}: VirtualMCPBadgeProps) {
  const [open, setOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { org } = useProjectContext();

  const virtualMcp = virtualMcps.find((g) => g.id === virtualMcpId);
  if (!virtualMcp || isDecopilot(virtualMcpId)) return null; // Don't show badge for Decopilot

  // Focus search input when popover opens
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
    }
  }, [open]);

  const color = getAgentColor(virtualMcpId);

  const handleReset = (e: MouseEvent) => {
    e.stopPropagation();
    onVirtualMcpChange(null);
  };

  const handleEdit = (e: MouseEvent) => {
    e.stopPropagation();
    navigate({
      to: "/$org/$project/agents/$agentId",
      params: {
        org: org.slug,
        project: ORG_ADMIN_PROJECT_SLUG,
        agentId: virtualMcpId,
      },
    });
  };

  const handleVirtualMcpChange = (newVirtualMcpId: string | null) => {
    onVirtualMcpChange(newVirtualMcpId);
    setOpen(false);
  };

  return (
    <div
      className={cn(
        "flex items-center justify-between px-3 py-1.5 rounded-t-xl z-10",
        color?.bg,
      )}
    >
      {/* Left side: Virtual MCP selector trigger with popover */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded-md hover:opacity-80 transition-opacity",
              disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
            )}
          >
            <span className="text-xs text-white font-normal">
              {virtualMcp.title}
            </span>
            <ChevronDown size={14} className="text-white/50" />
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
            selectedVirtualMcpId={virtualMcpId}
            onVirtualMcpChange={handleVirtualMcpChange}
            searchInputRef={searchInputRef}
          />
        </PopoverContent>
      </Popover>

      {/* Right side: Edit and Reset buttons */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={handleEdit}
          disabled={disabled}
          className={cn(
            "flex items-center justify-center p-1 rounded-full transition-colors",
            disabled
              ? "cursor-not-allowed opacity-50"
              : "cursor-pointer hover:bg-white/10",
          )}
          aria-label="Edit agent"
        >
          <Edit01 size={14} className="text-white" />
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={disabled}
          className={cn(
            "flex items-center justify-center p-1 rounded-full transition-colors",
            disabled
              ? "cursor-not-allowed opacity-50"
              : "cursor-pointer hover:bg-white/10",
          )}
          aria-label="Reset to default"
        >
          <XCircle size={14} className="text-white" />
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// ChatInput - Merged component with virtual MCP wrapper, banners, and selectors
// ============================================================================

export function ChatInput() {
  const {
    activeThreadId,
    tiptapDocRef,
    virtualMcps,
    selectedVirtualMcp,
    setVirtualMcpId,
    modelsConnections,
    selectedModel,
    setSelectedModel,
    selectedMode,
    setSelectedMode,
    messages,
    isStreaming,
    isRunInProgress,
    sendMessage,
    stop,
    cancelRun,
  } = useChat();

  // tiptapDoc lives here (not in context) so keystrokes don't re-render
  // the entire context tree. The ref on context lets IceBreakers read it.
  const [tiptapDoc, setTiptapDocLocal] =
    useState<Metadata["tiptapDoc"]>(undefined);

  const setTiptapDoc = (doc: Metadata["tiptapDoc"]) => {
    setTiptapDocLocal(doc);
    tiptapDocRef.current = doc;
  };

  // Reset input when switching threads (TiptapProvider also remounts via key)
  const prevThreadRef = useRef(activeThreadId);
  if (prevThreadRef.current !== activeThreadId) {
    prevThreadRef.current = activeThreadId;
    setTiptapDocLocal(undefined);
    tiptapDocRef.current = undefined;
  }

  const contextWindow = selectedModel?.thinking.limits?.contextWindow;

  const tiptapRef = useRef<TiptapInputHandle | null>(null);
  const usage = calculateUsageStats(messages);

  const lastUsage = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.metadata?.usage)?.metadata?.usage;
  const lastTotalTokens =
    (lastUsage?.totalTokens ?? 0) - (lastUsage?.reasoningTokens ?? 0);

  const canSubmit =
    !isStreaming && !!selectedModel && !isTiptapDocEmpty(tiptapDoc);

  const showStopOrCancel = isStreaming || isRunInProgress;

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    if (isStreaming) {
      stop();
    } else if (isRunInProgress) {
      void cancelRun();
    } else if (canSubmit && tiptapDoc) {
      void sendMessage(tiptapDoc);
      setTiptapDoc(undefined);
    }
  };

  // Track whether a non-Decopilot agent is active
  const hasAgentBadge =
    !!selectedVirtualMcp?.id && !isDecopilot(selectedVirtualMcp.id);

  // Track if wrapper visuals should still show (stays true during exit animation)
  const [showWrapper, setShowWrapper] = useState(false);
  if (hasAgentBadge && !showWrapper) {
    setShowWrapper(true);
  }

  const handleGridTransitionEnd = () => {
    if (!hasAgentBadge) {
      setShowWrapper(false);
      lastAgentRef.current = null;
    }
  };

  // Keep last active agent + color for exit animation
  const lastAgentRef = useRef<{
    id: string;
    virtualMcps: VirtualMCPInfo[];
    color: ReturnType<typeof getAgentColor>;
  } | null>(null);

  const color = selectedVirtualMcp
    ? getAgentColor(selectedVirtualMcp.id)
    : null;

  if (hasAgentBadge && selectedVirtualMcp?.id) {
    lastAgentRef.current = { id: selectedVirtualMcp.id, virtualMcps, color };
  }

  const badgeAgent = hasAgentBadge ? selectedVirtualMcp : null;
  const badgeAgentId = badgeAgent?.id ?? lastAgentRef.current?.id;
  const badgeVirtualMcps = badgeAgent
    ? virtualMcps
    : (lastAgentRef.current?.virtualMcps ?? []);
  // Use current color when active, last color during exit animation
  const wrapperBg = color?.bg ?? lastAgentRef.current?.color?.bg;

  return (
    <div className="flex flex-col w-full justify-end">
      {/* Virtual MCP wrapper with badge */}
      <div className="relative rounded-xl w-full flex flex-col">
        {/* Colored background overlay - stays during exit animation */}
        {showWrapper && (
          <div
            className={cn(
              "absolute inset-0 rounded-xl pointer-events-none",
              wrapperBg,
            )}
          />
        )}

        {/* Highlight floats above the form area */}
        <ChatHighlight />

        {/* Virtual MCP Badge Header - animated expand/collapse */}
        <div
          className={cn(
            "relative z-10 grid transition-[grid-template-rows] duration-250 ease-out overflow-hidden rounded-t-xl",
            hasAgentBadge ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
          onTransitionEnd={handleGridTransitionEnd}
        >
          <div className="overflow-hidden">
            {badgeAgentId && (
              <VirtualMCPBadge
                onVirtualMcpChange={setVirtualMcpId}
                virtualMcpId={badgeAgentId}
                virtualMcps={badgeVirtualMcps}
                disabled={isStreaming}
              />
            )}
          </div>
        </div>

        {/* Inner container with the input */}
        <div
          className={cn(
            "transition-[padding] duration-250 ease-out",
            showWrapper ? "p-0.5" : "p-0",
          )}
        >
          <TiptapProvider
            key={activeThreadId}
            tiptapDoc={tiptapDoc}
            setTiptapDoc={setTiptapDoc}
            selectedModel={selectedModel}
            isStreaming={isStreaming}
            onSubmit={handleSubmit}
          >
            <form
              onSubmit={handleSubmit}
              className={cn(
                "w-full relative rounded-xl min-h-[130px] flex flex-col border border-border bg-background shadow-sm",
              )}
            >
              <div className="relative flex flex-col gap-2 flex-1">
                {/* Input Area with Tiptap */}
                <TiptapInput
                  ref={tiptapRef}
                  selectedModel={selectedModel}
                  isStreaming={isStreaming}
                  selectedVirtualMcp={selectedVirtualMcp}
                />
              </div>

              {/* Bottom Actions Row */}
              <div className="flex items-center justify-between p-2.5">
                {/* Left Actions (agent, file upload, mode) */}
                <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                  {isRunInProgress && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      Run in progress
                    </span>
                  )}
                  {selectedVirtualMcp && isDecopilot(selectedVirtualMcp.id) ? (
                    <DecopilotIconButton
                      onVirtualMcpChange={setVirtualMcpId}
                      virtualMcps={virtualMcps}
                      disabled={isStreaming}
                    />
                  ) : (
                    <VirtualMCPSelector
                      selectedVirtualMcpId={selectedVirtualMcp?.id ?? null}
                      onVirtualMcpChange={setVirtualMcpId}
                      virtualMcps={virtualMcps}
                      placeholder="Agent"
                      disabled={isStreaming}
                    />
                  )}
                  <FileUploadButton
                    selectedModel={selectedModel}
                    isStreaming={isStreaming}
                  />
                  <ModeSelector
                    selectedMode={selectedMode}
                    onModeChange={setSelectedMode}
                    placeholder="Mode"
                    variant="borderless"
                    disabled={isStreaming}
                  />
                  {contextWindow && lastTotalTokens > 0 && (
                    <SessionStats
                      usage={usage}
                      totalTokens={lastTotalTokens}
                      contextWindow={contextWindow}
                    />
                  )}
                </div>

                {/* Right Actions (model, send) */}
                <div className="flex items-center gap-1.5">
                  <ModelSelector
                    selectedModel={selectedModel ?? undefined}
                    onModelChange={setSelectedModel}
                    modelsConnections={modelsConnections}
                    placeholder="Model"
                    variant="borderless"
                  />

                  <Button
                    type={showStopOrCancel ? "button" : "submit"}
                    onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                      if (showStopOrCancel) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (isStreaming) stop();
                        else void cancelRun();
                      }
                    }}
                    variant={
                      canSubmit || showStopOrCancel ? "default" : "ghost"
                    }
                    size="icon"
                    disabled={!canSubmit && !showStopOrCancel}
                    className={cn(
                      "size-8 rounded-full transition-all",
                      !canSubmit &&
                        !showStopOrCancel &&
                        "bg-muted text-muted-foreground hover:bg-muted hover:text-muted-foreground cursor-not-allowed",
                    )}
                    title={
                      isStreaming
                        ? "Stop generating"
                        : isRunInProgress
                          ? "Cancel run"
                          : "Send message (Enter)"
                    }
                  >
                    {showStopOrCancel ? (
                      <Stop size={20} />
                    ) : (
                      <ArrowUp size={20} />
                    )}
                  </Button>
                </div>
              </div>
            </form>
          </TiptapProvider>
        </div>
      </div>
    </div>
  );
}

import { isMac, isModKey } from "@/web/lib/keyboard-shortcuts";
import { calculateUsageStats } from "@/web/lib/usage-utils.ts";
import { getAgentWrapperColor } from "@/web/components/agent-icon";
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
  BookOpen01,
  ChevronDown,
  Edit01,
  Lock01,
  Stop,
  Users03,
  XCircle,
} from "@untitledui/icons";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import type { FormEvent } from "react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { Metadata } from "./types.ts";
import { useChat } from "./context";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { ChatHighlight } from "./highlight";
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
import { authClient } from "@/web/lib/auth-client.ts";

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
  const isMobile = useIsMobile();

  const decopilot = getWellKnownDecopilotVirtualMCP(org.id);

  // Filter out Decopilot from the list
  const filteredVirtualMcps = virtualMcps.filter(
    (virtualMcp) => !virtualMcp.id || !isDecopilot(virtualMcp.id),
  );

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
        className="w-[min(550px,calc(100vw-2rem))] p-0 overflow-hidden"
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={16}
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
  const isMobile = useIsMobile();

  const virtualMcp = virtualMcps.find((g) => g.id === virtualMcpId);

  // Focus search input when popover opens (skip on mobile to avoid keyboard popup)
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (open && !isMobile) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
    }
  }, [open, isMobile]);

  if (!virtualMcp || isDecopilot(virtualMcpId)) return null; // Don't show badge for Decopilot

  const color = getAgentWrapperColor(virtualMcp.icon, virtualMcp.title);

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
          className="w-[min(550px,calc(100vw-2rem))] p-0 overflow-hidden"
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
// PlanModeToggle - Toggle button for plan mode
// ============================================================================

function PlanModeToggle({ disabled }: { disabled?: boolean }) {
  const [preferences, setPreferences] = usePreferences();
  const isPlanMode = preferences.toolApprovalLevel === "plan";

  const handleToggle = () => {
    setPreferences({
      ...preferences,
      toolApprovalLevel: isPlanMode ? "auto" : "plan",
    });
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleToggle}
          disabled={disabled}
          className={cn(
            "flex items-center justify-center size-8 rounded-md transition-colors shrink-0",
            disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
            isPlanMode
              ? "border border-purple-500 text-purple-500 bg-purple-500/10 hover:bg-purple-500/20"
              : "border border-border text-muted-foreground/75 hover:text-muted-foreground",
          )}
          aria-label={isPlanMode ? "Exit plan mode" : "Enter plan mode"}
        >
          <BookOpen01 size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex items-center gap-1.5">
        {isPlanMode ? "Exit plan mode" : "Plan mode"}
        <span className="flex items-center gap-0.5">
          {(isMac ? ["⌘", "⇧", "L"] : ["Ctrl", "⇧", "L"]).map((key) => (
            <kbd
              key={key}
              className="inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-sm border border-white/20 bg-white/10 text-white/70 text-xs font-mono"
            >
              {key}
            </kbd>
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

// ============================================================================
// ChatInput - Merged component with virtual MCP wrapper, banners, and selectors
// ============================================================================

export function ChatInput({
  onOpenContextPanel,
}: {
  onOpenContextPanel?: () => void;
}) {
  const {
    activeTaskId,
    tiptapDocRef,
    virtualMcps,
    selectedVirtualMcp,
    setVirtualMcpId,
    model,
    isModelsLoading,
    messages,
    isStreaming,
    isRunInProgress,
    sendMessage,
    stop,
    cancelRun,
    tasks,
  } = useChat();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  const { org } = useProjectContext();
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;

  const task = tasks.find((task) => task.id === activeTaskId);

  // tiptapDoc lives here (not in context) so keystrokes don't re-render
  // the entire context tree. The ref on context lets IceBreakers read it.
  const [tiptapDoc, setTiptapDocLocal] =
    useState<Metadata["tiptapDoc"]>(undefined);

  const setTiptapDoc = (doc: Metadata["tiptapDoc"]) => {
    setTiptapDocLocal(doc);
    tiptapDocRef.current = doc;
  };

  // Reset input when switching tasks (TiptapProvider also remounts via key)
  const prevTaskRef = useRef(activeTaskId);
  if (prevTaskRef.current !== activeTaskId) {
    prevTaskRef.current = activeTaskId;
    setTiptapDocLocal(undefined);
    tiptapDocRef.current = undefined;
  }

  const contextWindow = model?.limits?.contextWindow;

  const tiptapRef = useRef<TiptapInputHandle | null>(null);

  const [preferences, setPreferences] = usePreferences();
  const isPlanMode = preferences.toolApprovalLevel === "plan";

  // Focus chat input on Cmd+L, toggle plan mode on Cmd+Shift+L
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (isModKey(e) && e.code === "KeyL") {
        e.preventDefault();
        if (e.shiftKey) {
          const isPlan = preferences.toolApprovalLevel === "plan";
          setPreferences({
            ...preferences,
            toolApprovalLevel: isPlan ? "auto" : "plan",
          });
        }
        tiptapRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [preferences, setPreferences]);

  const usage = calculateUsageStats(messages);

  const lastUsage = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.metadata?.usage)?.metadata?.usage;
  const lastTotalTokens =
    (lastUsage?.totalTokens ?? 0) - (lastUsage?.reasoningTokens ?? 0);

  const canSubmit =
    !isStreaming && !!model && !isModelsLoading && !isTiptapDocEmpty(tiptapDoc);

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
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (hasAgentBadge) {
      setShowWrapper(true);
    }
  }, [hasAgentBadge]);

  const handleGridTransitionEnd = (e: React.TransitionEvent) => {
    if (e.propertyName !== "grid-template-rows") return;
    if (!hasAgentBadge) {
      setShowWrapper(false);
      lastAgentRef.current = null;
    }
  };

  // Keep last active agent + color for exit animation
  const lastAgentRef = useRef<{
    id: string;
    virtualMcps: VirtualMCPInfo[];
    color: ReturnType<typeof getAgentWrapperColor> | null;
  } | null>(null);

  const color = selectedVirtualMcp
    ? getAgentWrapperColor(selectedVirtualMcp.icon, selectedVirtualMcp.title)
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

  if (userId && task?.created_by && task.created_by !== userId) {
    return (
      <div className="flex w-full items-center gap-2 px-3 py-2.5 rounded-xl border border-border bg-muted/40 text-muted-foreground">
        <Lock01 size={14} className="shrink-0" />
        <span className="text-sm">
          Read only — you&apos;re viewing someone else&apos;s thread
        </span>
      </div>
    );
  }

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
            key={activeTaskId}
            tiptapDoc={tiptapDoc}
            setTiptapDoc={setTiptapDoc}
            disabled={isStreaming || !model}
            enterToSubmit={true}
            onSubmit={handleSubmit}
          >
            <form
              onSubmit={handleSubmit}
              className={cn(
                "w-full relative rounded-xl min-h-[110px] md:min-h-[130px] flex flex-col border bg-background shadow-sm",
                isPlanMode
                  ? "border-dashed border-purple-500"
                  : "border-border",
              )}
              style={{
                boxShadow:
                  "inset 0 0 0.5px 1px hsla(0, 0%, 100%, 0.075), 0 0 0 1px hsla(0, 0%, 0%, 0.05), 0 0.3px 0.4px hsla(0, 0%, 0%, 0.02), 0 0.9px 1.5px hsla(0, 0%, 0%, 0.045), 0 3.5px 6px hsla(0, 0%, 0%, 0.09)",
              }}
            >
              <div className="group/input relative flex flex-col gap-2 flex-1">
                {/* Input Area with Tiptap */}
                <TiptapInput
                  ref={tiptapRef}
                  disabled={isStreaming || !model}
                  virtualMcpId={selectedVirtualMcp?.id ?? decopilotId}
                  showFileUploader={true}
                  selectedModel={model}
                />
                {/* Focus hint — hidden when editor is focused */}
                <span className="absolute top-3 right-3 text-xs text-muted-foreground/50 pointer-events-none select-none group-focus-within/input:hidden hidden md:inline">
                  {isMac ? "⌘" : "Ctrl+"}L to focus
                </span>
              </div>

              {/* Bottom Actions Row */}
              <div className="flex items-center justify-between p-2.5">
                {/* Left Actions (agent, file upload, mode) */}
                <div className="flex items-center gap-1.5 min-w-0 overflow-visible">
                  {isRunInProgress && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      Run in progress
                    </span>
                  )}
                  {!selectedVirtualMcp || isDecopilot(selectedVirtualMcp.id) ? (
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
                    selectedModel={model}
                    isStreaming={isStreaming}
                  />
                  <PlanModeToggle disabled={isStreaming} />
                  {contextWindow && lastTotalTokens > 0 && (
                    <SessionStats
                      usage={usage}
                      totalTokens={lastTotalTokens}
                      contextWindow={contextWindow}
                      onOpenContextPanel={onOpenContextPanel}
                    />
                  )}
                </div>

                {/* Right Actions (model, send) */}
                <div className="flex items-center gap-1.5">
                  <ModelSelector placeholder="Model" variant="borderless" />

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
                      "size-8 rounded-md transition-all",
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

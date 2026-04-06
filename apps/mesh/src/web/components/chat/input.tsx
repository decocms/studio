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
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import {
  ArrowUp,
  BookOpen01,
  ChevronDown,
  Edit01,
  Lock01,
  Stop,
  Upload01,
  Users03,
  XCircle,
} from "@untitledui/icons";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import type { FormEvent } from "react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { Metadata } from "./types.ts";
import { useChatStream, useChatTask, useChatPrefs } from "./context";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { ChatHighlight } from "./highlight";
import { ModelSelector } from "./select-model";
import {
  VirtualMCPPopoverContent,
  VirtualMCPSelector,
  type VirtualMCPInfo,
} from "./select-virtual-mcp";
import { modelSupportsFiles } from "./select-model";
import { FileUploadButton, processFile } from "./tiptap/file";
import { useCurrentEditor, type Editor } from "@tiptap/react";
import {
  TiptapInput,
  TiptapProvider,
  type TiptapInputHandle,
} from "./tiptap/input";
import { isTiptapDocEmpty } from "./tiptap/utils";
import { SessionStats } from "./usage-stats";
import { authClient } from "@/web/lib/auth-client.ts";
import { useSound } from "@/web/hooks/use-sound.ts";
import { clickSoftSound } from "@deco/ui/lib/click-soft.ts";
import { switch005Sound } from "@deco/ui/lib/switch-005.ts";

// ============================================================================
// DecopilotIconButton - Icon button for Decopilot (similar to FileUploadButton)
// ============================================================================

interface DecopilotIconButtonProps {
  onVirtualMcpChange: (virtualMcpId: string | null) => void;
  disabled?: boolean;
}

function DecopilotIconButton({
  onVirtualMcpChange,
  disabled = false,
}: DecopilotIconButtonProps) {
  const [open, setOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { org } = useProjectContext();
  const isMobile = useIsMobile();

  const decopilot = getWellKnownDecopilotVirtualMCP(org.id);

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
  virtualMcp: VirtualMCPInfo | null;
  onVirtualMcpChange: (virtualMcpId: string | null) => void;
  disabled?: boolean;
}

function VirtualMCPBadge({
  virtualMcp,
  onVirtualMcpChange,
  disabled = false,
}: VirtualMCPBadgeProps) {
  const [open, setOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const navigateToAgent = useNavigateToAgent();
  const { org } = useProjectContext();
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

  if (!virtualMcp?.id || isDecopilot(virtualMcp.id)) return null; // Don't show badge for Decopilot

  const themeColor = (
    virtualMcp as {
      metadata?: { ui?: { themeColor?: string | null } | null } | null;
    }
  ).metadata?.ui?.themeColor;
  const color = getAgentWrapperColor(
    virtualMcp.icon,
    virtualMcp.title,
    themeColor,
  );

  const handleReset = (e: MouseEvent) => {
    e.stopPropagation();
    const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
    onVirtualMcpChange(decopilotId);
  };

  const handleEdit = (e: MouseEvent) => {
    e.stopPropagation();
    navigateToAgent(virtualMcp.id!, { search: { main: "settings" } });
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
            selectedVirtualMcpId={virtualMcp.id}
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
  const playSwitchSound = useSound(switch005Sound);

  const handleToggle = () => {
    playSwitchSound();
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
// FileDropZone - Overlay that catches file drops from anywhere on the window
// ============================================================================

function FileDropZone({
  isDraggingOver,
  supportsFiles,
  editorRef,
}: {
  isDraggingOver: boolean;
  supportsFiles: boolean;
  editorRef: React.RefObject<Editor | null>;
}) {
  const { editor } = useCurrentEditor();

  // Keep the ref in sync so the window drop handler can access the editor
  editorRef.current = editor;

  return (
    <div
      className={cn(
        "absolute inset-0 z-20 rounded-xl flex flex-col items-center justify-center gap-2 bg-muted border-2 border-dashed transition-opacity",
        isDraggingOver ? "opacity-100" : "opacity-0 pointer-events-none",
        supportsFiles
          ? "border-primary/40 text-primary/70"
          : "border-destructive/30 text-destructive/70",
      )}
    >
      {supportsFiles ? (
        <>
          <Upload01 size={24} />
          <span className="text-sm font-medium">Drop files here</span>
        </>
      ) : (
        <>
          <Lock01 size={24} />
          <span className="text-sm font-medium">
            This model does not support files
          </span>
        </>
      )}
    </div>
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
  const { messages, isStreaming, isRunInProgress, sendMessage, stop } =
    useChatStream();
  const { taskId, tasks } = useChatTask();
  const { selectedModel, selectedVirtualMcp, isModelsLoading, tiptapDocRef } =
    useChatPrefs();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  const navigateToAgent = useNavigateToAgent();
  const { org } = useProjectContext();
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;

  // Navigate to the agent route (like the sidebar does) instead of only
  // setting an ephemeral search-param override, so the thread list re-scopes.
  const handleAgentChange = (virtualMcpId: string | null) => {
    if (virtualMcpId) {
      navigateToAgent(virtualMcpId);
    }
  };

  const task = tasks.find((task) => task.id === taskId);

  // tiptapDoc lives here (not in context) so keystrokes don't re-render
  // the entire context tree. The ref on context lets IceBreakers read it.
  const [tiptapDoc, setTiptapDocLocal] =
    useState<Metadata["tiptapDoc"]>(undefined);

  const setTiptapDoc = (doc: Metadata["tiptapDoc"]) => {
    setTiptapDocLocal(doc);
    tiptapDocRef.current = doc;
  };

  // Reset input when switching tasks (TiptapProvider also remounts via key)
  const prevTaskRef = useRef(taskId);
  if (prevTaskRef.current !== taskId) {
    prevTaskRef.current = taskId;
    setTiptapDocLocal(undefined);
    tiptapDocRef.current = undefined;
  }

  const contextWindow = selectedModel?.limits?.contextWindow;

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

  const playClickSound = useSound(clickSoftSound);

  const supportsFiles = modelSupportsFiles(selectedModel);

  // Ref to the editor instance, kept in sync by FileDropZone
  const editorRef = useRef<Editor | null>(null);
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;

  // Window-level drag detection for file drop zone
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        dragCounterRef.current++;
        setIsDraggingOver(true);
      }
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current--;
      if (dragCounterRef.current === 0) {
        setIsDraggingOver(false);
      }
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDraggingOver(false);

      const editor = editorRef.current;
      const model = selectedModelRef.current;
      if (!editor || !modelSupportsFiles(model)) return;

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      const { from } = editor.state.selection;
      for (const file of Array.from(files)) {
        void processFile(editor, model, file, from);
      }
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const canSubmit =
    !isStreaming &&
    !!selectedModel &&
    !isModelsLoading &&
    !isTiptapDocEmpty(tiptapDoc);

  const showStopOrCancel = isStreaming || isRunInProgress;

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    if (isStreaming) {
      stop();
    } else if (isRunInProgress) {
      stop();
    } else if (canSubmit && tiptapDoc) {
      playClickSound();
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
    virtualMcp: VirtualMCPInfo;
    color: ReturnType<typeof getAgentWrapperColor> | null;
  } | null>(null);

  const selectedThemeColor = (
    selectedVirtualMcp as {
      metadata?: { ui?: { themeColor?: string | null } | null } | null;
    } | null
  )?.metadata?.ui?.themeColor;
  const color = selectedVirtualMcp
    ? getAgentWrapperColor(
        selectedVirtualMcp.icon,
        selectedVirtualMcp.title,
        selectedThemeColor,
      )
    : null;

  if (hasAgentBadge && selectedVirtualMcp?.id) {
    lastAgentRef.current = { virtualMcp: selectedVirtualMcp, color };
  }

  // Use current agent when active, last agent during exit animation
  const badgeVirtualMcp = hasAgentBadge
    ? selectedVirtualMcp
    : (lastAgentRef.current?.virtualMcp ?? null);
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
            {badgeVirtualMcp && (
              <VirtualMCPBadge
                virtualMcp={badgeVirtualMcp}
                onVirtualMcpChange={handleAgentChange}
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
            key={taskId}
            tiptapDoc={tiptapDoc}
            setTiptapDoc={setTiptapDoc}
            disabled={isStreaming || !selectedModel}
            enterToSubmit={true}
            onSubmit={handleSubmit}
          >
            <form
              onSubmit={handleSubmit}
              className={cn(
                "w-full relative rounded-xl min-h-[110px] md:min-h-[130px] flex flex-col bg-background dark:bg-muted border",
                isPlanMode
                  ? "border-dashed border-purple-500 shadow-[0px_2px_6px_0px_#00000008,_0px_6px_30px_0px_#0000000a]"
                  : "border-transparent shadow-[0px_10px_28px_0px_rgba(0,0,0,0.06)] ring-1 ring-black/5 dark:ring-white/10",
              )}
            >
              <FileDropZone
                isDraggingOver={isDraggingOver}
                supportsFiles={supportsFiles}
                editorRef={editorRef}
              />

              <div className="group/input relative flex flex-col gap-2 flex-1">
                {/* Input Area with Tiptap */}
                <TiptapInput
                  ref={tiptapRef}
                  disabled={isStreaming || !selectedModel}
                  virtualMcpId={selectedVirtualMcp?.id ?? decopilotId}
                  showFileUploader={true}
                  selectedModel={selectedModel}
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
                  {!selectedVirtualMcp || isDecopilot(selectedVirtualMcp.id) ? (
                    <DecopilotIconButton
                      onVirtualMcpChange={handleAgentChange}
                      disabled={isStreaming}
                    />
                  ) : (
                    <VirtualMCPSelector
                      selectedVirtualMcpId={selectedVirtualMcp?.id ?? null}
                      selectedVirtualMcp={selectedVirtualMcp}
                      onVirtualMcpChange={handleAgentChange}
                      placeholder="Agent"
                      disabled={isStreaming}
                    />
                  )}
                  <FileUploadButton
                    selectedModel={selectedModel}
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
                        else stop();
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

import { isModKey } from "@/lib/keyboard-shortcuts";
import { calculateUsageStats } from "@/lib/usage-utils.ts";
import { AUTOSEND_QUERY_VALUE, writeStoredAutosend } from "@/lib/autosend";
import {
  HOME_DRAFT_KEY,
  clearChatDraft,
  readChatDraft,
  writeChatDraft,
} from "@/lib/chat-draft";
import { useT } from "@/i18n/use-t.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCP,
} from "@/sdk";
import { resolveFastPreview } from "@/sdk/fast-preview";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUp,
  BookOpen01,
  Check,
  Globe02,
  Image01,
  Lock01,
  Microphone01,
  Stop,
  Telescope,
  Upload01,
  X,
} from "@untitledui/icons";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Metadata } from "./types.ts";
import {
  useChatPrefs,
  useOptionalChatStream,
  useOptionalChatTask,
} from "./context";
import { useThreadActions } from "./store/hooks";
import type { VirtualMCPInfo } from "./select-virtual-mcp";
import { ChatHighlight } from "./highlight";
import { QueueTray } from "./queue-tray";
import { getSupportedFileTypesLabel, modelSupportsFiles } from "./select-model";
import { TierTrigger } from "./tier-trigger";
import type { AiProviderModel } from "@/hooks/collections/use-ai-providers";
import {
  UnsupportedFileDialog,
  useUnsupportedFileDialog,
  processFile,
  type UnsupportedFileInfo,
} from "./tiptap/file";
import { useCurrentEditor } from "@tiptap/react";
import {
  TiptapInput,
  TiptapProvider,
  type TiptapInputHandle,
} from "./tiptap/input";
import { isTiptapDocEmpty } from "./tiptap/utils";
import { ToolsPopover } from "./tools-popover";
import { SessionStats } from "./usage-stats";
import { authClient } from "@/lib/auth-client.ts";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { useMembersQuery } from "@/hooks/use-members";
import { track } from "@/lib/posthog-client";
import { useSound } from "@/hooks/use-sound.ts";
import { question004Sound } from "@/lib/sounds/question-004.ts";
import { AddConnectionDialog } from "@/views/virtual-mcp/add-connection-dialog";
import { ConnectionsBanner } from "./connections-banner";
import { useVoiceInput } from "@/hooks/use-voice-input.ts";
import { VoiceWaveform } from "./voice-input";
import { resolveComposerAction } from "./composer-action";
import { useIsDesktopApp } from "@/hooks/use-is-desktop-app";
import { shouldBlockHostedRuntime } from "./hosted-runtime-guard";

// ============================================================================
// useWindowFileDrop - Reusable hook for window-level file drag & drop
// ============================================================================

function ChatInputDisabledState({
  message,
  icon,
}: {
  message: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex w-full items-center gap-2 px-3 py-2.5 rounded-xl border border-border bg-muted/40 text-muted-foreground">
      {icon ?? <Lock01 size={14} className="shrink-0" />}
      <span className="text-sm">{message ?? ""}</span>
    </div>
  );
}

/**
 * Attaches window-level dragenter/dragleave/dragover/drop listeners and
 * processes dropped files into the current Tiptap editor.
 *
 * Must be called inside a TiptapProvider so `useCurrentEditor()` resolves.
 */
function useWindowFileDrop(
  selectedModel: AiProviderModel | null | undefined,
  onUnsupportedFile?: (info: UnsupportedFileInfo) => void,
  disabled?: boolean,
) {
  const { editor } = useCurrentEditor();
  const t = useT();
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
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
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

      if (
        disabled ||
        !editor ||
        !selectedModel ||
        !modelSupportsFiles(selectedModel)
      )
        return;

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      // Process files sequentially, re-reading the selection after each
      // insert so multiple files land in order instead of racing to insert
      // at the same stale position (see the ProseMirror-level fix for the
      // same race in tiptap/file/uploader.tsx).
      const fileArray = Array.from(files);
      void (async () => {
        let insertPos = editor.state.selection.from;
        for (const file of fileArray) {
          await processFile(
            editor,
            selectedModel,
            file,
            insertPos,
            onUnsupportedFile,
            t,
          );
          insertPos = editor.state.selection.to;
        }
      })();
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
  }, [editor, selectedModel, onUnsupportedFile, t, disabled]);

  return isDraggingOver;
}

// ============================================================================
// FileDropZone subcomponents - i18n-extracted strings
// ============================================================================

function FileDropZoneSupported({
  selectedModel,
}: {
  selectedModel: AiProviderModel | null | undefined;
}) {
  const t = useT();
  const { parts } = getSupportedFileTypesLabel(selectedModel);
  return (
    <>
      <Upload01 size={24} />
      <span className="text-sm font-medium">
        {t("chat.input.dropFilesHere", {
          fileTypes: parts.map((key) => t(key)).join(", "),
        })}
      </span>
    </>
  );
}

function FileDropZoneUnsupported() {
  const t = useT();
  return (
    <>
      <Lock01 size={24} />
      <span className="text-sm font-medium">
        {t("chat.input.modelCannotReadAttachments")}
      </span>
    </>
  );
}

// ============================================================================
// FileDropZone - Overlay that catches file drops from anywhere on the window
// ============================================================================

function FileDropZone({
  selectedModel,
  onUnsupportedFile,
  disabled,
}: {
  selectedModel: AiProviderModel | null | undefined;
  onUnsupportedFile?: (info: UnsupportedFileInfo) => void;
  disabled?: boolean;
}) {
  const isDraggingOver = useWindowFileDrop(
    selectedModel,
    onUnsupportedFile,
    disabled,
  );
  const supportsFiles = modelSupportsFiles(selectedModel);

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
        <FileDropZoneSupported selectedModel={selectedModel} />
      ) : (
        <FileDropZoneUnsupported />
      )}
    </div>
  );
}

// ============================================================================
// ModeDismissPill - "you're in mode X" pill with a dismiss (X) affordance,
// shown for plan/gen-image/web-search/deep-research modes.
// ============================================================================

function ModeDismissPill({
  onClick,
  label,
  icon,
  colorClass,
  maxWidthClass,
}: {
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
  colorClass: string;
  maxWidthClass: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex items-center gap-1.5 h-8 rounded-lg px-2.5 text-sm font-medium group min-w-0 shrink animate-in fade-in duration-200",
        colorClass,
      )}
    >
      {icon}
      <span
        className={cn(
          "min-w-0 truncate transition-[max-width,opacity] duration-200 ease-out max-w-0 opacity-0 @[320px]/chat-bottom:opacity-100",
          maxWidthClass,
        )}
      >
        {label}
      </span>
      <X
        size={14}
        className="shrink-0 hidden group-hover:block group-disabled:hidden"
      />
    </button>
  );
}

// ============================================================================
// ChatInput - Merged component with virtual MCP wrapper, banners, and selectors
// ============================================================================

/**
 * Submit handler for the home composer. No active task exists; we create
 * the thread synchronously via ThreadManagerStore so the row is in the
 * manager's `threads` list BEFORE navigation. The new task page's
 * `useEnsureTask` then resolves the localHit fast path on first render,
 * skipping its own CREATE (which would otherwise duplicate against React
 * 19 Strict Mode's intentional re-mount of the effect). Tiptap doc is
 * written to sessionStorage and ActiveTaskProvider's autosend consumer
 * fires sendMessage on mount.
 */
function useHomeSubmit() {
  const navigate = useNavigate();
  const { org, locator } = useProjectContext();
  const { create } = useThreadActions();

  return async ({
    tiptapDoc,
    virtualMcp,
  }: {
    tiptapDoc: Metadata["tiptapDoc"];
    virtualMcp: VirtualMCPInfo | null;
  }) => {
    const newId = crypto.randomUUID();
    const targetVmcp =
      virtualMcp?.id ?? getWellKnownDecopilotVirtualMCP(org.id).id;
    writeStoredAutosend(sessionStorage, locator, newId, { tiptapDoc });
    try {
      await create({ id: newId, virtual_mcp_id: targetVmcp });
    } catch {
      // Toast already surfaced by the store; navigate anyway — the route's
      // ensure-fallback will retry if the row is missing.
    }
    const search: Record<string, string> = {
      virtualmcpid: targetVmcp,
      autosend: AUTOSEND_QUERY_VALUE,
    };
    navigate({
      to: "/$org/$taskId",
      params: { org: org.slug, taskId: newId },
      search,
    });
  };
}

export function ChatInput({
  onOpenContextPanel,
  showConnectionsBanner = false,
}: {
  onOpenContextPanel?: () => void;
  showConnectionsBanner?: boolean;
}) {
  const t = useT();
  const stream = useOptionalChatStream();
  const taskCtx = useOptionalChatTask();
  const messages = stream?.messages ?? [];
  const isStreaming = stream?.isStreaming ?? false;
  const isRunInProgress = stream?.isRunInProgress ?? false;
  const stop = stream?.stop ?? (() => {});
  const taskId = taskCtx?.taskId ?? "";
  // Storage key for the per-thread (or home composer) draft.
  const draftKey = taskId || HOME_DRAFT_KEY;
  const homeSubmit = useHomeSubmit();
  const {
    selectedModel,
    selectedVirtualMcp,
    isModelsLoading,
    tiptapDocRef,
    imageModel,
    webSearchModel,
    deepResearchModel,
    chatMode,
    setChatMode,
  } = useChatPrefs();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  const { org, locator } = useProjectContext();
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
  const selectedVm = useVirtualMCP(selectedVirtualMcp?.id);
  const fastPreviewActive = resolveFastPreview(selectedVm?.metadata).active;
  const playSwitchSound = useSound(question004Sound);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const { unsupportedFile, onUnsupportedFile, clearUnsupportedFile } =
    useUnsupportedFileDialog();

  const voice = useVoiceInput();
  const voiceBaselineDocRef = useRef<Metadata["tiptapDoc"]>(undefined);

  const handleVoiceStart = async () => {
    voiceBaselineDocRef.current = tiptapDoc;
    // Fire with the real outcome returned by startRecording — reading
    // voice.status here instead would be a stale closure over the status
    // from before the click, since setState doesn't mutate it in place.
    const finalStatus = await voice.startRecording();
    const outcome =
      finalStatus === "recording"
        ? "started"
        : finalStatus === "unsupported"
          ? "unsupported"
          : finalStatus === "permission-denied"
            ? "permission_denied"
            : "unknown";
    track("chat_voice_started", { thread_id: taskId, outcome });
  };

  const handleVoiceConfirm = () => {
    track("chat_voice_confirmed", { thread_id: taskId });
    const finalText = voice.stopRecording();
    tiptapRef.current?.syncVoiceText(voiceBaselineDocRef.current, finalText);
    tiptapRef.current?.focus();
  };

  const handleVoiceCancel = () => {
    track("chat_voice_cancelled", { thread_id: taskId });
    voice.cancelRecording();
    tiptapRef.current?.restoreContent(voiceBaselineDocRef.current);
  };

  // Sync live transcript into the editor while recording
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (voice.status !== "recording") return;
    const voiceText = (
      voice.transcript +
      (voice.interimTranscript ? " " + voice.interimTranscript : "")
    ).trim();
    tiptapRef.current?.syncVoiceText(voiceBaselineDocRef.current, voiceText);
  }, [voice.transcript, voice.interimTranscript, voice.status]);

  const task = taskCtx?.activeTask ?? null;
  const ownerId = task?.created_by;
  const isOthersThread = Boolean(userId && ownerId && ownerId !== userId);
  // Only someone else's thread needs the member list — the read-only banner
  // names its owner.
  const { data: membersData } = useMembersQuery({ enabled: isOthersThread });
  const owner = (
    (membersData?.data?.members ?? []) as {
      userId: string;
      user?: {
        name?: string | null;
        email?: string | null;
        image?: string | null;
      };
    }[]
  ).find((m) => m.userId === ownerId);
  const ownerName =
    owner?.user?.name ?? owner?.user?.email?.split("@")[0] ?? null;
  const isDesktopApp = useIsDesktopApp();
  const hostedRuntimeBlocked = shouldBlockHostedRuntime({
    isDesktopApp,
    harnessId: task?.harness_id,
    sandboxProviderKind: task?.sandbox_provider_kind,
  });

  // tiptapDoc lives here (not in context) so keystrokes don't re-render
  // the entire context tree. The ref on context lets IceBreakers read it.
  // The lazy initializer hydrates the draft from sessionStorage on mount.
  const [tiptapDoc, setTiptapDocLocal] = useState<Metadata["tiptapDoc"]>(
    () => readChatDraft(sessionStorage, locator, draftKey) ?? undefined,
  );

  const setTiptapDoc = (doc: Metadata["tiptapDoc"]) => {
    setTiptapDocLocal(doc);
    tiptapDocRef.current = doc;
    writeChatDraft(sessionStorage, locator, draftKey, doc, {
      onQuotaExceeded: ({ docSizeBytes }) => {
        track("chat_draft_quota_exceeded", {
          thread_id: taskId || null,
          doc_size_bytes: docSizeBytes,
        });
        console.warn(
          "[chat-draft] sessionStorage quota exceeded; draft not saved",
        );
      },
    });
  };

  // When switching tasks, rehydrate the new task's draft from storage
  // (useState's lazy initializer only fires on mount). The previous
  // task's draft is left in sessionStorage and will be picked up if the
  // user navigates back.
  const prevTaskRef = useRef(taskId);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  if (prevTaskRef.current !== taskId) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    prevTaskRef.current = taskId;
    const restored =
      readChatDraft(sessionStorage, locator, draftKey) ?? undefined;
    setTiptapDocLocal(restored);
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    tiptapDocRef.current = restored;
  }

  // Prefer per-turn modelLimits (Claude Code reports real window at turn end)
  // so the ring renders even when catalog limits are null.
  const lastAssistantMetadata = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")?.metadata;
  const contextWindow =
    lastAssistantMetadata?.modelLimits?.contextWindow ??
    selectedModel?.limits?.contextWindow;

  const tiptapRef = useRef<TiptapInputHandle | null>(null);
  // True while the @/ suggestion dropdown is open — read by TiptapProvider's
  // Enter-to-submit handler so selecting a suggestion doesn't also send the
  // still-unresolved draft (ProseMirror's keydown listener runs before the
  // suggestion's own, see tiptap/input.tsx).
  const suggestionOpenRef = useRef(false);

  const isPlanMode = chatMode === "plan";

  const dismissChatMode = (fromMode: string) => {
    playSwitchSound();
    track("chat_mode_changed", {
      from_mode: fromMode,
      to_mode: "default",
      source: "pill_dismiss",
    });
    setChatMode("default");
  };

  // Focus chat input on Cmd+L, toggle plan mode on Cmd+Shift+L
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (isModKey(e) && e.code === "KeyL") {
        e.preventDefault();
        if (e.shiftKey) {
          setChatMode(chatMode === "plan" ? "default" : "plan");
        }
        tiptapRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [chatMode, setChatMode]);

  const usage = calculateUsageStats(messages);

  const lastUsage = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.metadata?.usage)?.metadata?.usage;
  // Per-turn context size (size of the prompt the model saw on the LATEST
  // step). Sibling `inputTokens`/`totalTokens` are cumulative across the
  // turn's steps — DO NOT fall back to them here; they read as if the
  // model's context is much fuller than it actually is.
  const lastTotalTokens = lastUsage?.contextTokens ?? 0;

  // A draft sends even mid-run — the new message enqueues behind the running
  // gate (concurrency=1 serializes the thread). Stop is offered only when
  // there's nothing to send. `canSubmit`/`showStopOrCancel` are kept as the
  // names the button/render logic below already references.
  const hasDraft = !isModelsLoading && !isTiptapDocEmpty(tiptapDoc);
  const composerAction = resolveComposerAction({
    hasDraft,
    isStreaming,
    isRunInProgress,
  });
  const canSubmit = composerAction === "send";
  const showStopOrCancel = composerAction === "stop";
  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    if (composerAction === "send" && tiptapDoc) {
      track("chat_message_sent", {
        thread_id: taskId || null,
        mode: chatMode,
        model_id: selectedModel?.modelId ?? null,
        model_provider: selectedModel?.providerId ?? null,
        virtual_mcp_id: selectedVirtualMcp?.id ?? null,
        submission: e ? "button_or_enter" : "programmatic",
      });
      if (stream) {
        // The per-thread send latch drops a re-entrant send synchronously
        // (see `sendInFlight` in chat-context.tsx). Probe it BEFORE firing
        // so a draft typed while the previous send's POST is still in
        // flight isn't cleared for a send that was silently dropped.
        if (stream.isSendInFlight()) {
          toast.info(t("chat.input.stillSendingPreviousMessage"));
          return;
        }
        void stream.sendMessage(tiptapDoc);
      } else {
        homeSubmit({ tiptapDoc, virtualMcp: selectedVirtualMcp });
      }
      clearChatDraft(sessionStorage, locator, draftKey);
      setTiptapDoc(undefined);
    } else if (composerAction === "stop") {
      track("chat_message_stopped", { thread_id: taskId });
      stop();
    }
  };

  if (isOthersThread) {
    return (
      <ChatInputDisabledState
        message={
          ownerName
            ? t("chat.input.readOnlyOthersChatNamed", { name: ownerName })
            : t("chat.input.readOnlyOthersChat")
        }
        icon={
          ownerName ? (
            <Avatar
              shape="circle"
              size="2xs"
              url={owner?.user?.image ?? undefined}
              fallback={ownerName.slice(0, 2).toUpperCase()}
            />
          ) : undefined
        }
      />
    );
  }

  // Autonomous runs (a sandbox-hosted claude-code task run) answer the one
  // prompt they were dispatched with; a follow-up would queue forever.
  if (task?.metadata?.read_only) {
    return <ChatInputDisabledState message={t("chat.input.readOnlyThread")} />;
  }

  if (hostedRuntimeBlocked) {
    return (
      <ChatInputDisabledState
        message={t("chat.input.codingAgentRequiresDesktop")}
      />
    );
  }

  // Fast Preview projects are sandbox-less, and a chat run still dispatches to
  // a sandbox runner — a message would hang against a runner that will never
  // exist. Hold the composer with an honest notice until the agent learns to
  // work through the decofile API (or per-thread sandbox fallback lands).
  if (fastPreviewActive) {
    return (
      <ChatInputDisabledState message={t("chat.input.fastPreviewComingSoon")} />
    );
  }

  return (
    <>
      <div className="flex flex-col w-full justify-end">
        <div className="relative rounded-2xl w-full flex flex-col">
          {/* Muted background for connections banner - peeks through form's bottom radius */}
          {showConnectionsBanner && (
            <div className="absolute inset-0 rounded-2xl pointer-events-none bg-muted/50" />
          )}

          {/* Highlight floats above the form area. Only renders when there's
              an active task — it depends on useChatStream + useChatTask, both
              absent on the home composer. */}
          {stream && taskCtx && <ChatHighlight />}

          {stream && taskCtx && taskId ? <QueueTray taskId={taskId} /> : null}

          <TiptapProvider
            key={taskId}
            tiptapDoc={tiptapDoc}
            setTiptapDoc={setTiptapDoc}
            disabled={voice.status === "recording"}
            enterToSubmit={true}
            placeholder={t("chat.input.placeholder")}
            onSubmit={handleSubmit}
            suggestionOpenRef={suggestionOpenRef}
          >
            <form
              onSubmit={handleSubmit}
              className={cn(
                "w-full relative rounded-2xl min-h-[110px] md:min-h-[130px] flex flex-col bg-card dark:bg-muted card-shadow overflow-hidden",
              )}
            >
              <FileDropZone
                selectedModel={selectedModel}
                onUnsupportedFile={onUnsupportedFile}
                disabled={voice.status === "recording"}
              />

              <div className="group/input relative flex flex-col gap-2 flex-1">
                <TiptapInput
                  ref={tiptapRef}
                  disabled={voice.status === "recording"}
                  virtualMcpId={selectedVirtualMcp?.id ?? decopilotId}
                  showFileUploader={true}
                  selectedModel={selectedModel}
                  onUnsupportedFile={onUnsupportedFile}
                  suggestionOpenRef={suggestionOpenRef}
                />
              </div>

              {/* Bottom Actions Row */}
              <div className="@container/chat-bottom flex items-center justify-between p-2.5 gap-1">
                {voice.status === "recording" ? (
                  <>
                    {/* Spacer */}
                    <div className="flex-1" />

                    {/* Waveform + Cancel + Confirm */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <VoiceWaveform data={voice.waveformData.slice(0, 28)} />
                      <button
                        type="button"
                        onClick={handleVoiceCancel}
                        className="flex items-center justify-center size-8 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={t("chat.input.cancelRecording")}
                      >
                        <X size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={handleVoiceConfirm}
                        className="flex items-center justify-center size-8 rounded-lg bg-foreground text-background hover:opacity-80 transition-opacity"
                        aria-label={t("chat.input.useTranscription")}
                      >
                        <Check size={16} />
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Left Actions (+, Tools, active tool pills, stats) */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      <ToolsPopover
                        disabled={false}
                        onOpenConnections={() => {
                          track("connections_dialog_opened", {
                            source: "tools_popover",
                            mode: "add",
                          });
                          setConnectionsOpen(true);
                        }}
                        virtualMcpId={selectedVirtualMcp?.id ?? decopilotId}
                        selectedModel={selectedModel}
                        isStreaming={isStreaming}
                        onUnsupportedFile={onUnsupportedFile}
                      />
                      {isPlanMode && (
                        <ModeDismissPill
                          onClick={() => dismissChatMode("plan")}
                          label={t("chat.input.planMode")}
                          icon={<BookOpen01 size={14} className="shrink-0" />}
                          colorClass="text-violet-600 dark:text-violet-400 hover:bg-violet-500/10"
                          maxWidthClass="@[320px]/chat-bottom:max-w-32"
                        />
                      )}
                      {chatMode === "gen-image" && imageModel && (
                        <ModeDismissPill
                          onClick={() => dismissChatMode("gen-image")}
                          label={t("chat.input.createImage")}
                          icon={<Image01 size={14} className="shrink-0" />}
                          colorClass="text-pink-600 dark:text-pink-400 hover:bg-pink-500/10 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                          maxWidthClass="@[320px]/chat-bottom:max-w-[120px]"
                        />
                      )}
                      {chatMode === "web-search" && webSearchModel && (
                        <ModeDismissPill
                          onClick={() => dismissChatMode("web-search")}
                          label={t("chat.input.webSearch")}
                          icon={<Globe02 size={14} className="shrink-0" />}
                          colorClass="text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                          maxWidthClass="@[320px]/chat-bottom:max-w-[120px]"
                        />
                      )}
                      {chatMode === "deep-research" && deepResearchModel && (
                        <ModeDismissPill
                          onClick={() => dismissChatMode("deep-research")}
                          label={t("chat.input.deepResearch")}
                          icon={<Telescope size={14} className="shrink-0" />}
                          colorClass="text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                          maxWidthClass="@[320px]/chat-bottom:max-w-[120px]"
                        />
                      )}
                      {contextWindow && lastTotalTokens > 0 && (
                        <SessionStats
                          usage={usage}
                          totalTokens={lastTotalTokens}
                          contextWindow={contextWindow}
                          onOpenContextPanel={onOpenContextPanel}
                        />
                      )}
                    </div>

                    {/* Right Actions (model, mic, send) */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      <TierTrigger />

                      {/* Microphone button — always enabled; the composer has
                          no disabled state, only a streaming state reflected by
                          the send/stop button. */}
                      {voice.isSupported && (
                        <Button
                          type="button"
                          onClick={handleVoiceStart}
                          disabled={false}
                          variant="ghost"
                          size="icon"
                          className={cn(
                            "size-8 rounded-lg transition-colors",
                            voice.status === "permission-denied"
                              ? "text-destructive hover:text-destructive hover:bg-destructive/10"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                          title={
                            voice.status === "permission-denied"
                              ? t("chat.input.microphoneAccessDenied")
                              : t("chat.input.voiceInput")
                          }
                          aria-label={
                            voice.status === "permission-denied"
                              ? t("chat.input.microphoneAccessDenied")
                              : t("chat.input.voiceInput")
                          }
                        >
                          <Microphone01 size={18} />
                        </Button>
                      )}

                      <Button
                        type={showStopOrCancel ? "button" : "submit"}
                        onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                          if (showStopOrCancel) {
                            e.preventDefault();
                            e.stopPropagation();
                            stop();
                          }
                        }}
                        variant={
                          canSubmit || showStopOrCancel ? "default" : "ghost"
                        }
                        size="icon"
                        disabled={!canSubmit && !showStopOrCancel}
                        className={cn(
                          "size-8 rounded-lg transition-all",
                          !canSubmit &&
                            !showStopOrCancel &&
                            "bg-muted text-muted-foreground hover:bg-muted hover:text-muted-foreground cursor-not-allowed",
                        )}
                        title={
                          composerAction === "stop"
                            ? isStreaming
                              ? t("chat.input.stopGenerating")
                              : t("chat.input.cancelRun")
                            : t("chat.input.sendMessageEnter")
                        }
                        aria-label={
                          composerAction === "stop"
                            ? isStreaming
                              ? t("chat.input.stopGenerating")
                              : t("chat.input.cancelRun")
                            : t("chat.input.sendMessage")
                        }
                      >
                        {showStopOrCancel ? (
                          <Stop size={20} />
                        ) : (
                          <ArrowUp size={20} />
                        )}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </form>
          </TiptapProvider>

          {/* Connections Banner Footer - always visible on home */}
          {showConnectionsBanner && (
            <ConnectionsBanner
              onClick={() => {
                track("connections_banner_clicked", {
                  source: "home_chat_input",
                });
                track("connections_dialog_opened", {
                  source: "home_banner",
                  mode: "add",
                });
                setConnectionsOpen(true);
              }}
            />
          )}
        </div>
      </div>

      <AddConnectionDialog
        mode="browse"
        open={connectionsOpen}
        onOpenChange={setConnectionsOpen}
        defaultTab="all"
      />

      <UnsupportedFileDialog
        info={unsupportedFile}
        onClose={clearUnsupportedFile}
      />
    </>
  );
}

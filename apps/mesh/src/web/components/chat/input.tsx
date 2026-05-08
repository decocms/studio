import { isModKey } from "@/web/lib/keyboard-shortcuts";
import { calculateUsageStats } from "@/web/lib/usage-utils.ts";
import { AUTOSEND_QUERY_VALUE, writeStoredAutosend } from "@/web/lib/autosend";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUp,
  BookOpen01,
  Check,
  Globe02,
  Image01,
  Lock01,
  Microphone01,
  Plus,
  Stop,
  Upload01,
  X,
} from "@untitledui/icons";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { Metadata } from "./types.ts";
import {
  useChatPrefs,
  useOptionalChatStream,
  useOptionalChatTask,
} from "./context";
import type { VirtualMCPInfo } from "./select-virtual-mcp";
import { ChatHighlight } from "./highlight";
import { ModelSelector } from "./select-model";
import { getSupportedFileTypesLabel, modelSupportsFiles } from "./select-model";
import { SimpleModeTierDropdown } from "./simple-mode-tier-dropdown";
import type { AiProviderModel } from "@/web/hooks/collections/use-ai-providers";
import {
  FileUploadButton,
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
import { authClient } from "@/web/lib/auth-client.ts";
import { track } from "@/web/lib/posthog-client";
import { useSound } from "@/web/hooks/use-sound.ts";
import { question004Sound } from "@deco/ui/lib/question-004.ts";
import { AddConnectionDialog } from "@/web/views/virtual-mcp/add-connection-dialog";
import { ConnectionsBanner } from "./connections-banner";
import { useVoiceInput } from "@/web/hooks/use-voice-input.ts";
import { VoiceWaveform } from "./voice-input";

// ============================================================================
// useWindowFileDrop - Reusable hook for window-level file drag & drop
// ============================================================================

/**
 * Attaches window-level dragenter/dragleave/dragover/drop listeners and
 * processes dropped files into the current Tiptap editor.
 *
 * Must be called inside a TiptapProvider so `useCurrentEditor()` resolves.
 */
function useWindowFileDrop(
  selectedModel: AiProviderModel | null | undefined,
  onUnsupportedFile?: (info: UnsupportedFileInfo) => void,
) {
  const { editor } = useCurrentEditor();
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

      if (!editor || !selectedModel || !modelSupportsFiles(selectedModel))
        return;

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      const { from } = editor.state.selection;
      for (const file of Array.from(files)) {
        void processFile(editor, selectedModel, file, from, onUnsupportedFile);
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
  }, [editor, selectedModel, onUnsupportedFile]);

  return isDraggingOver;
}

// ============================================================================
// FileDropZone - Overlay that catches file drops from anywhere on the window
// ============================================================================

function FileDropZone({
  selectedModel,
  onUnsupportedFile,
}: {
  selectedModel: AiProviderModel | null | undefined;
  onUnsupportedFile?: (info: UnsupportedFileInfo) => void;
}) {
  const isDraggingOver = useWindowFileDrop(selectedModel, onUnsupportedFile);
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
        <>
          <Upload01 size={24} />
          <span className="text-sm font-medium">
            Drop {getSupportedFileTypesLabel(selectedModel)} here
          </span>
        </>
      ) : (
        <>
          <Lock01 size={24} />
          <span className="text-sm font-medium">
            This model can't read attachments — switch to one with vision or
            file support
          </span>
        </>
      )}
    </div>
  );
}

// ============================================================================
// ChatInput - Merged component with virtual MCP wrapper, banners, and selectors
// ============================================================================

/**
 * Submit handler for the home composer. No active task exists; we write
 * the tiptap doc to sessionStorage and navigate to a fresh /$org/$taskId.
 * The new task page's useEnsureTask creates the thread (server-side
 * idempotent on id) and ActiveTaskProvider's autosend consumer fires
 * sendMessage on mount.
 */
function useHomeSubmit() {
  const navigate = useNavigate();
  const { org, locator } = useProjectContext();

  return ({
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
    navigate({
      to: "/$org/$taskId",
      params: { org: org.slug, taskId: newId },
      search: { virtualmcpid: targetVmcp, autosend: AUTOSEND_QUERY_VALUE },
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
  const stream = useOptionalChatStream();
  const taskCtx = useOptionalChatTask();
  const messages = stream?.messages ?? [];
  const isStreaming = stream?.isStreaming ?? false;
  const isRunInProgress = stream?.isRunInProgress ?? false;
  const stop = stream?.stop ?? (() => {});
  const taskId = taskCtx?.taskId ?? "";
  const tasks = taskCtx?.tasks ?? [];
  const homeSubmit = useHomeSubmit();
  const {
    selectedModel,
    selectedVirtualMcp,
    isModelsLoading,
    tiptapDocRef,
    imageModel,
    deepResearchModel,
    chatMode,
    setChatMode,
    simpleModeEnabled,
    simpleModeTier,
    setSimpleModeTier,
  } = useChatPrefs();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  const { org } = useProjectContext();
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
  const playSwitchSound = useSound(question004Sound);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const { unsupportedFile, onUnsupportedFile, clearUnsupportedFile } =
    useUnsupportedFileDialog();

  const voice = useVoiceInput();
  const voiceBaselineDocRef = useRef<Metadata["tiptapDoc"]>(undefined);

  const handleVoiceStart = async () => {
    voiceBaselineDocRef.current = tiptapDoc;
    await voice.startRecording();
    // Fire with the real outcome — voice.status is set inside startRecording
    // before the promise resolves ("recording" on success, "unsupported" or
    // "permission-denied" on failure). Button click on its own doesn't tell
    // us if the mic actually started.
    const outcome =
      voice.status === "recording"
        ? "started"
        : voice.status === "unsupported"
          ? "unsupported"
          : voice.status === "permission-denied"
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

  // Prefer per-turn modelLimits (Claude Code reports real window at turn end)
  // so the ring renders even when catalog limits are null.
  const lastAssistantMetadata = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")?.metadata;
  const contextWindow =
    lastAssistantMetadata?.modelLimits?.contextWindow ??
    selectedModel?.limits?.contextWindow;

  const tiptapRef = useRef<TiptapInputHandle | null>(null);

  const isPlanMode = chatMode === "plan";

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
  // Prefer per-turn context size; fall back to cumulative for legacy messages.
  const lastTotalTokens =
    lastUsage?.contextTokens ??
    (lastUsage?.totalTokens ?? 0) - (lastUsage?.reasoningTokens ?? 0);

  const playClickSound = useSound(question004Sound);

  const canSubmit =
    !isStreaming &&
    !!selectedModel &&
    !isModelsLoading &&
    !isTiptapDocEmpty(tiptapDoc);

  const showStopOrCancel = isStreaming || isRunInProgress;

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    if (isStreaming) {
      track("chat_message_stopped", { thread_id: taskId });
      stop();
    } else if (isRunInProgress) {
      track("chat_message_stopped", { thread_id: taskId });
      stop();
    } else if (canSubmit && tiptapDoc) {
      track("chat_message_sent", {
        thread_id: taskId || null,
        mode: chatMode,
        model_id: selectedModel?.modelId ?? null,
        model_provider: selectedModel?.providerId ?? null,
        virtual_mcp_id: selectedVirtualMcp?.id ?? null,
        submission: e ? "button_or_enter" : "programmatic",
      });
      playClickSound();
      if (stream) {
        void stream.sendMessage(tiptapDoc);
      } else {
        homeSubmit({ tiptapDoc, virtualMcp: selectedVirtualMcp });
      }
      setTiptapDoc(undefined);
    }
  };

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
                "w-full relative rounded-2xl min-h-[110px] md:min-h-[130px] flex flex-col bg-background dark:bg-muted card-shadow",
              )}
            >
              <FileDropZone
                selectedModel={selectedModel}
                onUnsupportedFile={onUnsupportedFile}
              />

              <div className="group/input relative flex flex-col gap-2 flex-1">
                <TiptapInput
                  ref={tiptapRef}
                  disabled={
                    isStreaming ||
                    !selectedModel ||
                    voice.status === "recording"
                  }
                  virtualMcpId={selectedVirtualMcp?.id ?? decopilotId}
                  showFileUploader={true}
                  selectedModel={selectedModel}
                  onUnsupportedFile={onUnsupportedFile}
                />
              </div>

              {/* Bottom Actions Row */}
              <div className="flex items-center justify-between p-2.5 gap-1">
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
                        aria-label="Cancel recording"
                      >
                        <X size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={handleVoiceConfirm}
                        className="flex items-center justify-center size-8 rounded-lg bg-foreground text-background hover:opacity-80 transition-opacity"
                        aria-label="Use transcription"
                      >
                        <Check size={16} />
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Left Actions (+, Tools, active tool pills, stats) */}
                    <div className="flex items-center gap-1.5 min-w-0 shrink-0">
                      <FileUploadButton
                        selectedModel={selectedModel}
                        isStreaming={isStreaming}
                        icon={<Plus size={16} />}
                        onUnsupportedFile={onUnsupportedFile}
                      />
                      <ToolsPopover
                        disabled={isStreaming}
                        onOpenConnections={() => {
                          track("connections_dialog_opened", {
                            source: "tools_popover",
                            mode: "add",
                          });
                          setConnectionsOpen(true);
                        }}
                        virtualMcpId={selectedVirtualMcp?.id ?? decopilotId}
                      />
                      {isPlanMode && (
                        <button
                          type="button"
                          onClick={() => {
                            playSwitchSound();
                            track("chat_mode_changed", {
                              from_mode: "plan",
                              to_mode: "default",
                              source: "pill_dismiss",
                            });
                            setChatMode("default");
                          }}
                          className="flex items-center gap-1.5 h-8 rounded-lg px-2.5 text-sm font-medium text-violet-600 dark:text-violet-400 hover:bg-violet-500/10 group whitespace-nowrap animate-in fade-in duration-200"
                        >
                          <BookOpen01 size={14} className="shrink-0" />
                          Plan mode
                          <X
                            size={14}
                            className="shrink-0 hidden group-hover:block"
                          />
                        </button>
                      )}
                      {chatMode === "gen-image" && imageModel && (
                        <button
                          type="button"
                          onClick={() => {
                            playSwitchSound();
                            track("chat_mode_changed", {
                              from_mode: "gen-image",
                              to_mode: "default",
                              source: "pill_dismiss",
                            });
                            setChatMode("default");
                          }}
                          className="flex items-center gap-1.5 h-8 rounded-lg px-2.5 text-sm font-medium text-pink-600 dark:text-pink-400 hover:bg-pink-500/10 group whitespace-nowrap animate-in fade-in duration-200"
                        >
                          <Image01 size={14} className="shrink-0" />
                          <span className="max-w-[120px] truncate">
                            {simpleModeEnabled
                              ? "Create image"
                              : imageModel.title.includes(": ")
                                ? imageModel.title
                                    .split(": ")
                                    .slice(1)
                                    .join(": ")
                                : imageModel.title}
                          </span>
                          <X
                            size={14}
                            className="shrink-0 hidden group-hover:block"
                          />
                        </button>
                      )}
                      {chatMode === "web-search" && deepResearchModel && (
                        <button
                          type="button"
                          onClick={() => {
                            playSwitchSound();
                            track("chat_mode_changed", {
                              from_mode: "web-search",
                              to_mode: "default",
                              source: "pill_dismiss",
                            });
                            setChatMode("default");
                          }}
                          className="flex items-center gap-1.5 h-8 rounded-lg px-2.5 text-sm font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 group whitespace-nowrap animate-in fade-in duration-200"
                        >
                          <Globe02 size={14} className="shrink-0" />
                          <span className="max-w-[120px] truncate">
                            {simpleModeEnabled
                              ? "Web search"
                              : deepResearchModel.title.includes(": ")
                                ? deepResearchModel.title
                                    .split(": ")
                                    .slice(1)
                                    .join(": ")
                                : deepResearchModel.title}
                          </span>
                          <X
                            size={14}
                            className="shrink-0 hidden group-hover:block"
                          />
                        </button>
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

                    {/* Right Actions (mic, model, send) */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      {simpleModeEnabled ? (
                        <SimpleModeTierDropdown
                          tier={simpleModeTier}
                          onSelect={setSimpleModeTier}
                        />
                      ) : (
                        <ModelSelector
                          placeholder="Model"
                          variant="borderless"
                          className="h-8 text-sm py-2 min-w-0"
                        />
                      )}

                      {/* Microphone button — only shown when not streaming and speech is supported */}
                      {voice.isSupported &&
                        !isStreaming &&
                        !isRunInProgress && (
                          <Button
                            type="button"
                            onClick={handleVoiceStart}
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
                                ? "Microphone access denied — click to try again"
                                : "Voice input"
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
                          "size-8 rounded-lg transition-all",
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

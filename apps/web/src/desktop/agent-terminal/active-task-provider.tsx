import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import { useSearch } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  ChatStreamValueProvider,
  useChatPrefs,
  useChatTask,
  type ChatStreamContextValue,
} from "@/components/chat/context";
import {
  AGENT_OPTION_PINS,
  type LocalAgentOption,
} from "@/components/chat/pills/agent-options";
import { useThreadManager } from "@/components/chat/store/hooks";
import type { ChatMessage } from "@/components/chat/types";
import { useT } from "@/i18n/use-t";
import {
  AUTOSEND_QUERY_VALUE,
  claimStoredAutosend,
  clearStoredAutosend,
  restoreStoredAutosend,
} from "@/lib/autosend";
import { useProjectContext } from "@/sdk";
import { authClient } from "@/lib/auth-client";
import {
  appendAppContexts,
  promptContentFromParts,
  promptContentFromSendMessage,
} from "./prompt";
import {
  fromTerminalHarnessId,
  terminalPromptFitsWire,
  toTerminalHarnessId,
  type TerminalHarnessId,
} from "./protocol";
import {
  getOrCreateTerminalController,
  TerminalPromptDeliveryUnknownError,
  type TerminalController,
  type TerminalControllerSnapshot,
} from "./terminal-controller";

interface NativeTerminalRuntimeValue {
  controller: TerminalController;
  snapshot: TerminalControllerSnapshot;
  isReadOnly: boolean;
  startAgent: (option: LocalAgentOption) => Promise<void>;
}

const NativeTerminalRuntimeContext =
  createContext<NativeTerminalRuntimeValue | null>(null);
const EMPTY_MESSAGES: ChatMessage[] = [];

export function useNativeTerminalRuntime(): NativeTerminalRuntimeValue {
  const value = useContext(NativeTerminalRuntimeContext);
  if (!value) {
    throw new Error("Native terminal runtime provider is missing");
  }
  return value;
}

function streamStatus(
  snapshot: TerminalControllerSnapshot,
): ChatStreamContextValue["status"] {
  if (snapshot.error) return "error";
  if (snapshot.logicalState === "working") return "streaming";
  if (
    snapshot.pendingPromptCount > 0 ||
    snapshot.physicalState === "starting" ||
    snapshot.connection === "connecting" ||
    snapshot.connection === "reconnecting"
  ) {
    return "submitted";
  }
  return "ready";
}

export function NativeAgentTerminalProvider({
  taskId,
  children,
}: PropsWithChildren<{ taskId: string }>) {
  const t = useT();
  const { org, locator } = useProjectContext();
  const task = useChatTask();
  const prefs = useChatPrefs();
  const manager = useThreadManager();
  const { data: session } = authClient.useSession();
  const search = useSearch({ strict: false }) as { autosend?: string };
  const controller = getOrCreateTerminalController(org.slug, taskId);
  const snapshot = useSyncExternalStore(
    controller.snapshot.subscribe,
    controller.snapshot.get,
    controller.snapshot.get,
  );
  const lockedHarness = toTerminalHarnessId(task.lockedHarness);
  const pendingHarness = toTerminalHarnessId(prefs.pendingHarnessId);
  const isReadOnly =
    !task.activeTask?.created_by ||
    task.activeTask.created_by !== session?.user?.id;
  const shouldAutosend = search.autosend === AUTOSEND_QUERY_VALUE;
  const unsupportedHarnessMessage = t("chat.nativeTerminal.unsupportedHarness");

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- WebSocket controller ownership follows the task workspace lifecycle
  useEffect(() => {
    controller.retain();
    return () => controller.release();
  }, [controller]);

  // Native terminal failures belong in the app-level notification surface.
  // A stable per-chat id prevents Strict Mode and reconnect snapshots from
  // stacking duplicate toasts for the same active failure.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- Sonner reflects errors published by the external terminal controller
  useEffect(() => {
    if (!snapshot.error) return;
    toast.error(snapshot.error.message, {
      id: `native-terminal-error:${taskId}`,
    });
  }, [snapshot.error, taskId]);

  // A persisted local harness is authoritative. Attaching is idempotent and
  // never starts the legacy chat connection.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- external terminal attachment follows the persisted thread pin
  useEffect(() => {
    if (!task.isThreadLocked || isReadOnly) return;
    if (!lockedHarness) {
      controller.reportError(new Error(unsupportedHarnessMessage));
      return;
    }
    controller.ensureAttached(lockedHarness);
  }, [
    controller,
    isReadOnly,
    lockedHarness,
    task.isThreadLocked,
    unsupportedHarnessMessage,
  ]);

  // Mirror authoritative lifecycle frames into the shared thread slot. The
  // regular /watch feed remains the durable source of truth; this avoids a
  // one-frame picker/sidebar lag after a successful native start.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- external lifecycle frames update the shared thread store
  useEffect(() => {
    const studioHarness = snapshot.hasSession
      ? fromTerminalHarnessId(snapshot.harnessId)
      : null;
    if (!studioHarness && !snapshot.threadStatus) return;
    manager.patchThread({
      id: taskId,
      ...(studioHarness
        ? {
            harness_id: studioHarness,
            sandbox_provider_kind: "user-desktop",
          }
        : {}),
      ...(snapshot.threadStatus ? { status: snapshot.threadStatus } : {}),
    });
  }, [
    manager,
    snapshot.hasSession,
    snapshot.harnessId,
    snapshot.threadStatus,
    taskId,
  ]);

  const selectedHarness = (
    override?: TerminalHarnessId,
  ): TerminalHarnessId | null =>
    override ?? snapshot.harnessId ?? lockedHarness ?? pendingHarness;

  const dispatchPrompt = async (
    prompt: string,
    requestId: string,
    overrideHarness?: TerminalHarnessId,
  ): Promise<void> => {
    const rejectDispatch = (message: string): never => {
      const error = new Error(message);
      controller.reportError(error);
      throw error;
    };
    if (isReadOnly) {
      return rejectDispatch(t("chat.nativeTerminal.readOnly"));
    }
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      return rejectDispatch(t("chat.nativeTerminal.emptyPrompt"));
    }

    const harness = selectedHarness(overrideHarness);
    if (!harness) {
      return rejectDispatch(t("chat.nativeTerminal.chooseAgentFirst"));
    }
    if (!terminalPromptFitsWire(normalizedPrompt, requestId, harness)) {
      return rejectDispatch(t("chat.nativeTerminal.promptTooLarge"));
    }
    const current = controller.snapshot.get();
    if (task.isThreadLocked) {
      controller.ensureAttached(harness);
      await controller.submitPrompt(normalizedPrompt, requestId);
      return;
    }
    if (
      current.hasSession &&
      current.physicalState !== "exited" &&
      current.physicalState !== "failed"
    ) {
      await controller.submitPrompt(normalizedPrompt, requestId);
      return;
    }
    await controller.start(harness, {
      initialPrompt: normalizedPrompt,
      requestId,
    });
  };

  const requireSupportedPrompt = (
    content: ReturnType<typeof promptContentFromSendMessage>,
  ): string => {
    if (!content.hasUnsupportedAttachments) return content.text;
    const error = new Error(t("chat.nativeTerminal.attachmentsUnsupported"));
    controller.reportError(error);
    throw error;
  };

  const claimAutosend = () => {
    if (!shouldAutosend) return null;
    const payload = claimStoredAutosend(sessionStorage, locator, taskId);
    if (!payload) return null;
    return {
      ...payload,
      requestId: `native-autosend:${taskId}:${payload.createdAt}`,
    };
  };

  const dispatchAutosend = async (
    harness?: TerminalHarnessId,
  ): Promise<boolean> => {
    const payload = claimAutosend();
    if (!payload) return false;
    try {
      const prompt = appendAppContexts(
        requireSupportedPrompt(promptContentFromSendMessage(payload.message)),
        prefs.appContexts,
      );
      await dispatchPrompt(prompt, payload.requestId, harness);
      clearStoredAutosend(sessionStorage, locator, taskId);
      return true;
    } catch (error) {
      if (error instanceof TerminalPromptDeliveryUnknownError) {
        // The PTY may already be processing this handoff. Retaining it would
        // replay the same turn on the next renderer mount.
        clearStoredAutosend(sessionStorage, locator, taskId);
      } else {
        restoreStoredAutosend(
          sessionStorage,
          locator,
          taskId,
          payload.createdAt,
          payload.attempt,
        );
      }
      throw error;
    }
  };

  // New chats created by another Studio surface carry their prompt through
  // the existing autosend handoff. Claiming in storage plus controller-level
  // request IDs makes this Strict Mode safe.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- sessionStorage handoff must be consumed when the terminal runtime becomes available
  useEffect(() => {
    if (!shouldAutosend || isReadOnly) return;
    if (snapshot.physicalState === "failed") return;
    if (snapshot.pendingPromptCount > 0) return;
    const harness = selectedHarness();
    if (!harness) return;
    void dispatchAutosend(harness).catch((error: unknown) => {
      if (controller.snapshot.get().error) return;
      controller.reportError(
        error instanceof Error
          ? error
          : new Error(t("chat.nativeTerminal.promptFailed")),
      );
    });
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps -- storage claim and controller request id, not callback identity, gate duplicate sends
  }, [
    controller,
    isReadOnly,
    lockedHarness,
    pendingHarness,
    shouldAutosend,
    snapshot.logicalState,
    snapshot.physicalState,
  ]);

  const sendPrompt = async (prompt: string): Promise<void> => {
    await dispatchPrompt(
      appendAppContexts(prompt, prefs.appContexts),
      crypto.randomUUID(),
    );
  };

  const sendMessage: ChatStreamContextValue["sendMessage"] = async (value) => {
    await sendPrompt(
      requireSupportedPrompt(promptContentFromSendMessage(value)),
    );
  };

  const streamValue: ChatStreamContextValue = {
    messages: EMPTY_MESSAGES,
    status: streamStatus(snapshot),
    sendMessage,
    editQueuedMessage: async () => false,
    stop: () => {
      if (!isReadOnly) controller.interrupt();
    },
    submit: async (action) => {
      if (action.kind !== "message") {
        throw new Error(t("chat.nativeTerminal.structuredActionUnsupported"));
      }
      await sendPrompt(
        requireSupportedPrompt(promptContentFromParts(action.message.parts)),
      );
    },
    removeLocalMessage: () => {},
    isSendInFlight: () => controller.snapshot.get().pendingPromptCount > 0,
    error: snapshot.error,
    clearError: () => controller.clearError(),
    finishReason: null,
    runStatusStage:
      snapshot.physicalState === "starting" ? "starting-run" : null,
    clearFinishReason: () => {},
    isStreaming: snapshot.logicalState === "working",
    isChatEmpty: true,
    isWaitingForApprovals: snapshot.logicalState === "waiting_input",
    isRunInProgress: snapshot.logicalState === "working",
    hasMoreOlder: false,
    isFetchingOlder: false,
    fetchOlderMessages: async () => {},
  };

  const runtimeValue: NativeTerminalRuntimeValue = {
    controller,
    snapshot,
    isReadOnly,
    startAgent: async (option) => {
      if (isReadOnly) throw new Error(t("chat.nativeTerminal.readOnly"));
      const harness = toTerminalHarnessId(AGENT_OPTION_PINS[option].harness);
      if (!harness) {
        throw new Error(t("chat.nativeTerminal.unsupportedHarness"));
      }
      if (await dispatchAutosend(harness)) return;
      await controller.start(harness);
    },
  };

  return (
    <NativeTerminalRuntimeContext.Provider value={runtimeValue}>
      <ChatStreamValueProvider value={streamValue}>
        {children}
      </ChatStreamValueProvider>
    </NativeTerminalRuntimeContext.Provider>
  );
}

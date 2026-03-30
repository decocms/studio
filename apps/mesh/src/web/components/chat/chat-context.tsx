/**
 * Chat Provider — split architecture with Suspense boundary support.
 *
 * TaskProvider (outer)
 *   Contexts: ChatTaskContext, ChatPrefsContext, ChatBridgeContext
 *   Owns: task list, navigation, preferences, transport, pending messages
 *
 * ActiveTaskProvider (inner, inside Suspense)
 *   Context: ChatStreamContext
 *   Owns: per-task streaming state (useChat, messages, status)
 *
 * The split allows a Suspense boundary between the sidebar (task list) and
 * the active chat panel. Switching tasks shows a skeleton while keeping the
 * sidebar interactive.
 */

import {
  createContext,
  useContext,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { useChat as useAIChat, type UseChatHelpers } from "@ai-sdk/react";
import {
  lastAssistantMessageIsCompleteWithToolCalls,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  DefaultChatTransport,
  type UIMessage,
} from "ai";
import {
  selectDefaultModel,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import { toast } from "sonner";

import {
  useAiProviderKeys,
  useAiProviderModels,
  type AiProviderModel,
} from "../../hooks/collections/use-ai-providers";
import { useContext as useContextHook } from "../../hooks/use-context";
import {
  usePreferences,
  type ToolApprovalLevel,
} from "../../hooks/use-preferences";
import { useInvalidateCollectionsOnToolCall } from "../../hooks/use-invalidate-collections-on-tool-call";
import { useTaskReadState } from "../../hooks/use-task-read-state";
import { authClient } from "../../lib/auth-client";
import { toMetadataModelInfo } from "../../lib/metadata-model-info";

import { useChatNavigation } from "./hooks/use-chat-navigation";
import { useStreamManager } from "./hooks/use-stream-manager";
import { useTaskManager, type TaskOwnerFilter } from "./task";
import { useTaskMessages } from "./task/use-task-manager";
import { derivePartsFromTiptapDoc } from "./derive-parts";
import type { VirtualMCPInfo } from "./select-virtual-mcp";
import type { ChatMessage, Metadata } from "./types";
import type { Task } from "./task/types";
import type {
  FinishPayload,
  SendMessageParams,
  SetAppContextParams,
} from "./store/types";
import { useLocalStorage } from "../../hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "../../lib/localstorage-keys";

// ============================================================================
// Context Types
// ============================================================================

export interface ChatStreamContextValue {
  messages: ChatMessage[];
  status: "ready" | "submitted" | "streaming" | "error";
  sendMessage: (
    params: SendMessageParams | Metadata["tiptapDoc"],
  ) => Promise<void>;
  stop: () => void;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  addToolOutput: UseChatHelpers<ChatMessage>["addToolOutput"];
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  error: Error | null;
  clearError: () => void;
  finishReason: string | null;
  clearFinishReason: () => void;
  isStreaming: boolean;
  isChatEmpty: boolean;
  isWaitingForApprovals: boolean;
  isRunInProgress: boolean;
}

export interface ChatTaskContextValue {
  virtualMcpId: string;
  taskId: string;
  openTask: (taskId: string) => void;
  createTask: () => string;
  createTaskWithMessage: (params: {
    message: SendMessageParams;
    virtualMcpId?: string;
  }) => void;
  tasks: Task[];
  hideTask: (taskId: string) => Promise<void>;
  renameTask: (taskId: string, title: string) => Promise<void>;
  setTaskStatus: (taskId: string, status: string) => Promise<void>;
  ownerFilter: TaskOwnerFilter;
  setOwnerFilter: (filter: TaskOwnerFilter) => void;
  isFilterChangePending: boolean;
  pendingMessage: {
    taskId: string;
    message: SendMessageParams;
    createdAt: number;
  } | null;
  clearPendingMessage: () => void;
}

export interface ChatPrefsContextValue {
  selectedModel: AiProviderModel | null;
  setModel: (model: AiProviderModel) => void;
  credentialId: string | null;
  setCredentialId: (id: string | null) => void;
  allModelsConnections: ReturnType<typeof useAiProviderKeys>;
  isModelsLoading: boolean;
  selectedVirtualMcp: VirtualMCPInfo | null;
  appContexts: Record<string, string>;
  setAppContext: (sourceId: string, params: SetAppContextParams) => void;
  clearAppContext: (sourceId: string) => void;
  tiptapDoc: Metadata["tiptapDoc"];
  setTiptapDoc: (doc: Metadata["tiptapDoc"]) => void;
  /** @deprecated Use tiptapDoc directly */
  tiptapDocRef: { current: Metadata["tiptapDoc"] };
  /** Set ephemeral per-task agent override. Passing null resets to URL agent. */
  setVirtualMcpId: (id: string | null) => void;
  /** @deprecated No-op */
  resetInteraction: () => void;
}

export interface ChatBridgeValue {
  sendMessage: (params: SendMessageParams) => Promise<void>;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_APP_CONTEXT_LENGTH = 10_000;
const MAX_APP_CONTEXT_SOURCES = 10;
const PENDING_MESSAGE_TTL_MS = 10_000;

const BRIDGE_NOOP: ChatBridgeValue = {
  sendMessage: async () => {
    console.warn(
      "[ChatBridge] sendMessage called but ActiveTaskProvider not mounted",
    );
  },
};

/** Internal-only type for cross-provider communication */
interface TaskProviderInternals {
  transport: DefaultChatTransport<UIMessage<Metadata>>;
  effectiveKeyId: string | null;
  user: { image?: string | null; name?: string } | null;
  contextPrompt: string;
  preferences: {
    toolApprovalLevel?: ToolApprovalLevel;
  };
  taskManager: {
    updateMessagesCache: (taskId: string, messages: ChatMessage[]) => void;
    updateTask: (taskId: string, updates: Partial<Task>) => void;
  };
  rawNavigateToTask: (taskId: string) => void;
  bridgeRef: React.RefObject<ChatBridgeValue>;
}

// ============================================================================
// Contexts
// ============================================================================

const ChatStreamCtx = createContext<ChatStreamContextValue | null>(null);
const ChatTaskCtx = createContext<ChatTaskContextValue | null>(null);
const ChatPrefsCtx = createContext<ChatPrefsContextValue | null>(null);
const ChatBridgeCtx = createContext<ChatBridgeValue>(BRIDGE_NOOP);

/** Internal context for passing TaskProvider internals to ActiveTaskProvider */
const TaskInternalsCtx = createContext<TaskProviderInternals | null>(null);

// ============================================================================
// TaskProvider (outer)
// ============================================================================

export function ChatContextProvider({
  virtualMcpId,
  children,
}: PropsWithChildren<{ virtualMcpId: string }>) {
  const { org, locator } = useProjectContext();
  const { data: session } = authClient.useSession();
  const user = session?.user ?? null;

  // URL state
  const {
    taskId: urlTaskId,
    virtualMcpOverride,
    navigateToTask: rawNavigateToTask,
    setVirtualMcpOverride,
  } = useChatNavigation();

  // Preferences
  const [preferences] = usePreferences();
  const { markTaskRead } = useTaskReadState();

  // Model selection (localStorage-backed)
  const [storedModel, setStoredModel] = useLocalStorage<AiProviderModel | null>(
    LOCALSTORAGE_KEYS.chatSelectedModel(locator),
    null,
  );
  const [storedCredentialId, setStoredCredentialId] = useLocalStorage<
    string | null
  >(LOCALSTORAGE_KEYS.chatSelectedKeyId(locator), null);

  // AI provider keys and models
  const keys = useAiProviderKeys();
  const effectiveKeyId = keys.some((k) => k.id === storedCredentialId)
    ? storedCredentialId
    : (keys[0]?.id ?? null);
  // Only fetch models when no stored model — once the user picks one, skip the fetch
  const needsDefault = !storedModel;
  const { models: defaultKeyModels, isLoading: isModelsQueryLoading } =
    useAiProviderModels(
      needsDefault ? (effectiveKeyId ?? undefined) : undefined,
    );
  const effectiveProviderId =
    keys.find((k) => k.id === effectiveKeyId)?.providerId ?? "anthropic";
  const defaultModel = selectDefaultModel(
    defaultKeyModels,
    effectiveProviderId,
    effectiveKeyId ?? undefined,
  );
  const selectedModel = storedModel ?? defaultModel;
  const isModelsLoading = needsDefault && isModelsQueryLoading;

  // Task management (scoped by URL virtualMcpId — task list doesn't change on override)
  const taskManager = useTaskManager(virtualMcpId);
  const { tasks } = taskManager;

  // taskId always comes from the URL (seeded by router's validateSearch)
  const effectiveTaskId = urlTaskId;

  // Effective agent: URL override (ephemeral per-task) ?? path param (thread owner)
  const effectiveVirtualMcpId = virtualMcpOverride ?? virtualMcpId;

  // Single-item fetch for the selected virtual MCP (no full list needed)
  const selectedVirtualMcpData = useVirtualMCP(effectiveVirtualMcpId);
  const selectedVirtualMcp: VirtualMCPInfo = selectedVirtualMcpData ?? {
    id: effectiveVirtualMcpId,
    title: "",
    description: null,
    icon: null,
  };

  // Context prompt (uses effective agent)
  const contextPrompt = useContextHook(effectiveVirtualMcpId);

  // App contexts
  const [appContexts, setAppContextsState] = useState<Record<string, string>>(
    {},
  );
  const setAppContext = (sourceId: string, params: SetAppContextParams) => {
    const textParts: string[] = [];
    for (const block of params.content ?? []) {
      if (block.type === "text" && block.text?.trim()) {
        textParts.push(block.text.trim());
      }
    }
    const text = textParts.join("\n");
    if (!text) {
      clearAppContext(sourceId);
      return;
    }
    if (new TextEncoder().encode(text).length > MAX_APP_CONTEXT_LENGTH) return;
    setAppContextsState((prev) => {
      if (
        Object.keys(prev).length >= MAX_APP_CONTEXT_SOURCES &&
        !(sourceId in prev)
      )
        return prev;
      return { ...prev, [sourceId]: text };
    });
  };
  const clearAppContext = (sourceId: string) => {
    setAppContextsState((prev) => {
      const { [sourceId]: _, ...rest } = prev;
      return rest;
    });
  };

  // Tiptap doc (transient UI state)
  const [tiptapDoc, setTiptapDoc] = useState<Metadata["tiptapDoc"]>(undefined);
  const tiptapDocRef = useRef<Metadata["tiptapDoc"]>(tiptapDoc);
  tiptapDocRef.current = tiptapDoc;

  // Refs for transport closure (avoid stale captures)
  const prefsRef = useRef({
    toolApprovalLevel: preferences.toolApprovalLevel,
  });
  prefsRef.current = { toolApprovalLevel: preferences.toolApprovalLevel };

  // Transport (created once per provider mount via ref)
  const transportRef = useRef<DefaultChatTransport<UIMessage<Metadata>> | null>(
    null,
  );
  if (!transportRef.current) {
    transportRef.current = new DefaultChatTransport<UIMessage<Metadata>>({
      api: `/api/${org.slug}/decopilot/stream`,
      credentials: "include",
      prepareReconnectToStreamRequest: ({ id }) => ({
        api: `/api/${org.slug}/decopilot/attach/${id}`,
      }),
      prepareSendMessagesRequest: ({ messages, requestMetadata = {} }) => {
        const {
          system,
          tiptapDoc: _tiptapDoc,
          ...metadata
        } = requestMetadata as Metadata;
        const systemMessage: UIMessage<Metadata> | null = system
          ? {
              id: crypto.randomUUID(),
              role: "system",
              parts: [{ type: "text", text: system }],
            }
          : null;
        const userMessage = messages.slice(-1).filter(Boolean) as ChatMessage[];
        const allMessages = systemMessage
          ? [systemMessage, ...userMessage]
          : userMessage;

        const lastMsgMeta = (messages.at(-1)?.metadata ?? {}) as Metadata;
        const mergedMetadata = {
          ...metadata,
          agent: metadata.agent ?? lastMsgMeta.agent,
          models: metadata.models ?? lastMsgMeta.models,
          thread_id: metadata.thread_id ?? lastMsgMeta.thread_id,
        };

        return {
          api: `/api/${org.slug}/decopilot/stream`,
          body: {
            messages: allMessages,
            ...mergedMetadata,
            ...(prefsRef.current.toolApprovalLevel && {
              toolApprovalLevel: prefsRef.current.toolApprovalLevel,
            }),
          },
        };
      },
    });
  }

  // Bridge ref — ActiveTaskProvider registers sendMessage here
  const bridgeRef = useRef<ChatBridgeValue>(BRIDGE_NOOP);

  // Pending message state (replaces module-level Map from useSendToChat)
  const [pendingMessage, setPendingMessage] = useState<{
    taskId: string;
    message: SendMessageParams;
    createdAt: number;
  } | null>(null);

  const clearPendingMessage = () => setPendingMessage(null);

  // Navigate to task with read tracking
  const navigateToTask = (
    taskId: string,
    opts?: { virtualMcpOverride?: string },
  ) => {
    markTaskRead(taskId);
    rawNavigateToTask(taskId, opts);
  };

  // Create task (optimistic + navigate), returns new task ID
  const createTask = (): string => {
    const newId = taskManager.createTask();
    navigateToTask(newId);
    return newId;
  };

  // Create task + queue a pending message for ActiveTaskProvider to consume
  const createTaskWithMessage = (params: {
    message: SendMessageParams;
    virtualMcpId?: string;
  }) => {
    const newId = taskManager.createTask();
    navigateToTask(newId, {
      virtualMcpOverride:
        params.virtualMcpId && params.virtualMcpId !== virtualMcpId
          ? params.virtualMcpId
          : undefined,
    });
    setPendingMessage({
      taskId: newId,
      message: params.message,
      createdAt: Date.now(),
    });
  };

  // Hide task (switch to next after hiding)
  const hideTask = async (taskId: string) => {
    await taskManager.hideTask(taskId);
    if (taskId === effectiveTaskId) {
      const next = tasks.find((t) => t.id !== taskId && !t.hidden);
      if (next) {
        navigateToTask(next.id);
      } else {
        createTask();
      }
    }
  };

  // ---- Build context values ----

  const taskValue: ChatTaskContextValue = {
    virtualMcpId: effectiveVirtualMcpId,
    taskId: effectiveTaskId,
    openTask: navigateToTask,
    createTask,
    createTaskWithMessage,
    tasks,
    hideTask,
    renameTask: taskManager.renameTask,
    setTaskStatus: taskManager.setTaskStatus,
    ownerFilter: taskManager.ownerFilter,
    setOwnerFilter: taskManager.setOwnerFilter,
    isFilterChangePending: taskManager.isFilterChangePending ?? false,
    pendingMessage,
    clearPendingMessage,
  };

  const prefsValue: ChatPrefsContextValue = {
    selectedModel,
    setModel: (model: AiProviderModel) => {
      setStoredModel(model);
      if (model.keyId) setStoredCredentialId(model.keyId);
    },
    credentialId: effectiveKeyId,
    setCredentialId: setStoredCredentialId,
    allModelsConnections: keys,
    isModelsLoading,
    selectedVirtualMcp,
    appContexts,
    setAppContext,
    clearAppContext,
    tiptapDoc,
    setTiptapDoc,
    tiptapDocRef,
    setVirtualMcpId: setVirtualMcpOverride,
    resetInteraction: () => {},
  };

  const internals: TaskProviderInternals = {
    transport: transportRef.current!,
    effectiveKeyId,
    user,
    contextPrompt,
    preferences,
    taskManager: {
      updateMessagesCache: taskManager.updateMessagesCache,
      updateTask: taskManager.updateTask,
    },
    rawNavigateToTask,
    bridgeRef,
  };

  return (
    <ChatTaskCtx.Provider value={taskValue}>
      <ChatPrefsCtx.Provider value={prefsValue}>
        <ChatBridgeCtx.Provider value={bridgeRef.current}>
          <TaskInternalsCtx.Provider value={internals}>
            {children}
          </TaskInternalsCtx.Provider>
        </ChatBridgeCtx.Provider>
      </ChatPrefsCtx.Provider>
    </ChatTaskCtx.Provider>
  );
}

// ============================================================================
// ActiveTaskProvider (inner, inside Suspense)
// ============================================================================

export function ActiveTaskProvider({
  taskId,
  children,
}: PropsWithChildren<{ taskId: string }>) {
  const { virtualMcpId, tasks, pendingMessage, clearPendingMessage } =
    useChatTask();
  const { selectedModel, appContexts, setTiptapDoc, setModel } = useChatPrefs();
  const internals = useContext(TaskInternalsCtx);
  if (!internals) {
    throw new Error(
      "ActiveTaskProvider must be used within ChatContextProvider",
    );
  }

  const {
    transport,
    effectiveKeyId,
    user,
    contextPrompt,
    preferences,
    taskManager,
    rawNavigateToTask,
    bridgeRef,
  } = internals;

  const { org } = useProjectContext();

  // Messages for current task (from React Query / server) — this is what suspends
  const serverMessages = useTaskMessages(taskId || null);

  const [finishReason, setFinishReason] = useState<string | null>(null);
  const [chatError, setChatError] = useState<Error | null>(null);

  const onToolCall = useInvalidateCollectionsOnToolCall();

  // AI SDK — useChat with taskId as id (multiplexed)
  const chat = useAIChat<ChatMessage>({
    id: taskId,
    messages: serverMessages,
    transport,
    sendAutomaticallyWhen: ({ messages }) =>
      lastAssistantMessageIsCompleteWithToolCalls({ messages }) ||
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages }),
    onFinish: (payload: FinishPayload) => {
      setFinishReason(payload.finishReason ?? null);

      const serverThreadId = (payload.message.metadata as Metadata | undefined)
        ?.thread_id;

      // Handle server thread_id reassignment
      if (serverThreadId && serverThreadId !== taskId) {
        rawNavigateToTask(serverThreadId);
      }

      if (payload.isAbort || payload.isDisconnect || payload.isError) {
        if (serverThreadId && payload.messages.length > 0) {
          taskManager.updateMessagesCache(serverThreadId, payload.messages);
        }
        return;
      }

      if (serverThreadId && payload.messages.length > 0) {
        taskManager.updateMessagesCache(serverThreadId, payload.messages);
      } else {
        console.warn(
          "[chat] onFinish: no thread_id in server metadata, messages not persisted",
        );
      }
    },
    onToolCall: onToolCall as never,
    onError: (error: Error) => {
      setChatError(error);
      console.error("[chat] Error", error);
    },
    onData: ({ data, type }) => {
      if (type === "data-thread-title") {
        const { title } = data;
        if (!title) return;
        taskManager.updateTask(taskId, {
          title,
          updated_at: new Date().toISOString(),
        });
      }
    },
  });

  // Derived state
  const isStreaming =
    chat.status === "submitted" || chat.status === "streaming";
  const messages = chat.status !== "ready" ? chat.messages : serverMessages;
  const isChatEmpty = messages.length === 0;
  const lastMessage = messages.at(-1);
  const isWaitingForApprovals =
    !isStreaming &&
    lastMessage?.role === "assistant" &&
    lastMessage.parts.some(
      (part) => "state" in part && part.state === "approval-requested",
    );
  const thread = tasks.find((t) => t.id === taskId);
  const isRunInProgress =
    (thread?.status === "in_progress" || thread?.status === "expired") &&
    chat.status === "ready" &&
    messages.length > 0;

  // Stream manager (SSE + resume) — task-scoped
  useStreamManager(taskId, org.id, chat);

  // sendMessage — captures context at call time
  async function sendMessageInternal(params: SendMessageParams): Promise<void> {
    const model = params.model ?? selectedModel;
    if (!model) {
      toast.error("No model configured");
      return;
    }

    const parts = params.parts ?? derivePartsFromTiptapDoc(params.tiptapDoc);
    if (parts.length === 0) return;

    // Capture at send time (frozen in closure)
    const capturedTaskId = taskId;
    const capturedVirtualMcpId = virtualMcpId;

    if (params.model) setModel(params.model);

    setFinishReason(null);
    setTiptapDoc(undefined);

    const messageMetadata: Metadata = {
      tiptapDoc: params.tiptapDoc,
      created_at: new Date().toISOString(),
      thread_id: capturedTaskId,
      agent: { id: capturedVirtualMcpId },
      user: {
        avatar: user?.image ?? undefined,
        name: user?.name ?? "you",
      },
      ...(preferences.toolApprovalLevel && {
        toolApprovalLevel: preferences.toolApprovalLevel,
      }),
    };

    const appContextEntries = Object.entries(appContexts);
    const appContextSection =
      appContextEntries.length > 0
        ? appContextEntries
            .map(([source, text]) => `### App Context: ${source}\n${text}`)
            .join("\n\n")
        : "";
    const system = [contextPrompt, appContextSection]
      .filter(Boolean)
      .join("\n\n");

    const metadata: Metadata = {
      ...messageMetadata,
      system,
      models: {
        credentialId: model.keyId ?? effectiveKeyId ?? "",
        thinking: toMetadataModelInfo(model),
        fast: toMetadataModelInfo(model),
      },
    };

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts,
      metadata: messageMetadata,
    };

    await chat.sendMessage(userMessage, { metadata });
  }

  // Cancel run
  const cancelRun = async () => {
    chat.stop();
    try {
      const res = await fetch(`/api/${org.slug}/decopilot/cancel/${taskId}`, {
        method: "POST",
        credentials: "include",
      });
      // 404 means the thread was never persisted (optimistic-only) — nothing to cancel
      if (res.status === 404) return;
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(data.message ?? `Cancel failed: ${res.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to cancel";
      toast.error(msg);
      console.error("[chat] cancelRun", err);
    }
  };

  // sendMessage wrapper: accept both SendMessageParams and raw tiptapDoc
  const sendMessagePublic = (
    params: SendMessageParams | Metadata["tiptapDoc"],
  ): Promise<void> => {
    if (params && typeof params === "object" && "type" in params) {
      return sendMessageInternal({
        tiptapDoc: params as Metadata["tiptapDoc"],
      });
    }
    return sendMessageInternal(params as SendMessageParams);
  };

  // Register sendMessage on the bridge so TaskProvider-level code can call it
  bridgeRef.current = { sendMessage: sendMessageInternal };

  // Consume pending message when this task is the target
  const pendingConsumedRef = useRef<string | null>(null);
  if (
    pendingMessage &&
    pendingMessage.taskId === taskId &&
    pendingConsumedRef.current !== taskId
  ) {
    // TTL check: discard stale messages
    const age = Date.now() - pendingMessage.createdAt;
    if (age < PENDING_MESSAGE_TTL_MS) {
      pendingConsumedRef.current = taskId;
      const msg = pendingMessage.message;
      queueMicrotask(() => {
        void sendMessageInternal(msg);
        clearPendingMessage();
      });
    } else {
      // Stale — silently discard
      queueMicrotask(() => clearPendingMessage());
    }
  }

  const streamValue: ChatStreamContextValue = {
    messages,
    status: chat.status,
    sendMessage: sendMessagePublic,
    stop: () => void cancelRun(),
    setMessages: chat.setMessages,
    addToolOutput: chat.addToolOutput,
    addToolApprovalResponse: chat.addToolApprovalResponse,
    error: chatError,
    clearError: () => setChatError(null),
    finishReason,
    clearFinishReason: () => setFinishReason(null),
    isStreaming,
    isChatEmpty,
    isWaitingForApprovals: isWaitingForApprovals ?? false,
    isRunInProgress,
  };

  return (
    <ChatStreamCtx.Provider value={streamValue}>
      {children}
    </ChatStreamCtx.Provider>
  );
}

// ============================================================================
// Hooks
// ============================================================================

export function useChatStream(): ChatStreamContextValue {
  const ctx = useContext(ChatStreamCtx);
  if (!ctx)
    throw new Error("useChatStream must be used within ActiveTaskProvider");
  return ctx;
}

export function useOptionalChatStream(): ChatStreamContextValue | null {
  return useContext(ChatStreamCtx);
}

export function useChatTask(): ChatTaskContextValue {
  const ctx = useContext(ChatTaskCtx);
  if (!ctx)
    throw new Error("useChatTask must be used within ChatContextProvider");
  return ctx;
}

export function useChatPrefs(): ChatPrefsContextValue {
  const ctx = useContext(ChatPrefsCtx);
  if (!ctx)
    throw new Error("useChatPrefs must be used within ChatContextProvider");
  return ctx;
}

export function useChatBridge(): ChatBridgeValue {
  return useContext(ChatBridgeCtx);
}

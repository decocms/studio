/**
 * Chat Context
 *
 * Manages chat interaction, task management, virtual MCP/model selection, and chat session state.
 * Provides optimized state management to minimize re-renders across the component tree.
 */

import type { ToolSelectionStrategy } from "@/mcp-clients/virtual-mcp/types";
import { useChat as useAIChat, type UseChatHelpers } from "@ai-sdk/react";
import type { ProjectLocator } from "@decocms/mesh-sdk";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import type { McpUiUpdateModelContextRequest } from "@modelcontextprotocol/ext-apps";
import type {
  EmbeddedResource,
  PromptMessage,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from "ai";
import {
  createContext,
  type PropsWithChildren,
  Suspense,
  useContext,
  useDeferredValue,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useDecopilotEvents } from "../../hooks/use-decopilot-events";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AiProviderModel,
  useAiProviderKeyList,
  useAiProviderModels,
} from "../../hooks/collections/use-llm";
import { selectDefaultModel } from "@decocms/mesh-sdk";
import { useContext as useContextHook } from "../../hooks/use-context";
import { useInvalidateCollectionsOnToolCall } from "../../hooks/use-invalidate-collections-on-tool-call";
import { useLocalStorage } from "../../hooks/use-local-storage";
import { ErrorBoundary } from "../error-boundary";
import { useNotification } from "../../hooks/use-notification";
import { usePreferences } from "../../hooks/use-preferences";
import { authClient } from "../../lib/auth-client";
import { KEYS } from "../../lib/query-keys";
import { LOCALSTORAGE_KEYS } from "../../lib/localstorage-keys";
import type { VirtualMCPInfo } from "./select-virtual-mcp";
import { useTaskManager, type Task, type TaskOwnerFilter } from "./task";
import type { FileAttrs } from "./tiptap/file/node.tsx";
import type { ChatMessage, Metadata } from "./types.ts";
import {
  chatStateReducer,
  initialChatState,
  type ChatState,
  type ChatStateAction,
} from "./chat-state";
// ============================================================================
// Type Definitions
// ============================================================================

export type { ChatState, ChatStateAction };

/** Fields from useChat we pass through directly (typed via UseChatHelpers) */
type ChatFromUseChat = Pick<
  UseChatHelpers<ChatMessage>,
  | "messages"
  | "status"
  | "setMessages"
  | "error"
  | "clearError"
  | "stop"
  | "addToolOutput"
  | "addToolApprovalResponse"
>;

/**
 * Stable context — values that change infrequently (model/task/mode selection, actions).
 * Consumers reading only stable fields skip re-renders during streaming.
 */
interface ChatStableValue {
  tiptapDocRef: React.RefObject<Metadata["tiptapDoc"]>;
  resetInteraction: () => void;

  activeTaskId: string;
  createTask: () => void;
  switchToTask: (taskId: string) => Promise<void>;
  renameTask: (taskId: string, title: string) => Promise<void>;
  tasks: Task[];
  hideTask: (taskId: string) => void;

  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  fetchNextPage?: () => void;

  ownerFilter: TaskOwnerFilter;
  setOwnerFilter: (filter: TaskOwnerFilter) => void;
  isFilterChangePending: boolean;

  virtualMcps: VirtualMCPInfo[];
  selectedVirtualMcp: VirtualMCPInfo | null;
  setVirtualMcpId: (virtualMcpId: string | null) => void;

  model: AiProviderModel | null;
  isModelsLoading: boolean;
  setSelectedModel: (model: AiProviderModel) => void;

  selectedMode: ToolSelectionStrategy;
  setSelectedMode: (mode: ToolSelectionStrategy) => void;

  sendMessage: (tiptapDoc: Metadata["tiptapDoc"]) => Promise<void>;
  cancelRun: () => Promise<void>;
  setAppContext: (
    sourceId: string,
    params: McpUiUpdateModelContextRequest["params"],
  ) => void;
  clearAppContext: (sourceId: string) => void;
  allModelsConnections: ReturnType<typeof useAiProviderKeyList>;
  credentialId: string | null;
  setCredentialId: (credentialId: string | null) => void;
}

/**
 * Stream context — values that change per chunk or stream lifecycle event.
 * Messages are deferred via useDeferredValue so React skips intermediate renders.
 */
interface ChatStreamValue extends ChatFromUseChat {
  isStreaming: boolean;
  isChatEmpty: boolean;
  finishReason: string | null;
  clearFinishReason: () => void;
  /** Derived from chat.messages (AI SDK state) to avoid stale reads during message source switches */
  isWaitingForApprovals: boolean;
  /** True when task is in_progress but we have no active local stream */
  isRunInProgress: boolean;
}

type ChatContextValue = ChatStableValue & ChatStreamValue;

// ============================================================================
// Helpers
// ============================================================================

function toMetadataModelInfo(
  model: AiProviderModel,
): import("./types").MetadataModelInfo {
  const caps = model.capabilities;
  const capabilities =
    caps && caps.length > 0
      ? {
          vision: caps.includes("vision") || undefined,
          text: caps.includes("text") || undefined,
          tools: caps.includes("tools") || undefined,
        }
      : undefined;
  return {
    id: model.modelId,
    title: model.title,
    provider: model.providerId,
    capabilities,
    limits: model.limits
      ? {
          contextWindow: model.limits.contextWindow,
          maxOutputTokens: model.limits.maxOutputTokens ?? undefined,
        }
      : undefined,
  };
}

// ============================================================================
// Implementation
// ============================================================================

const createModelsTransport = (
  org: string,
  /** Live ref to the current toolApprovalLevel preference. */
  toolApprovalLevelRef: { current: string | undefined },
): DefaultChatTransport<UIMessage<Metadata>> =>
  new DefaultChatTransport<UIMessage<Metadata>>({
    api: `/api/${org}/decopilot/stream`,
    credentials: "include",
    prepareReconnectToStreamRequest: ({ id }) => ({
      api: `/api/${org}/decopilot/attach/${id}`,
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

      // Fall back to last message metadata when requestMetadata is missing fields
      // (e.g. during re-sends from addToolOutput / addToolApprovalResponse)
      const lastMsgMeta = (messages.at(-1)?.metadata ?? {}) as Metadata;
      const mergedMetadata = {
        ...metadata,
        agent: metadata.agent ?? lastMsgMeta.agent,
        models: metadata.models ?? lastMsgMeta.models,
        thread_id: metadata.thread_id ?? lastMsgMeta.thread_id,
      };

      return {
        body: {
          messages: allMessages,
          ...mergedMetadata,
          // Always read from the live ref so changing the approval level
          // dropdown takes effect immediately, including during auto-sends
          // after addToolApprovalResponse.
          ...(toolApprovalLevelRef.current && {
            toolApprovalLevel: toolApprovalLevelRef.current,
          }),
        },
      };
    },
  });

/**
 * Converts resource contents to UI message parts
 */
function resourcesToParts(
  contents: ReadResourceResult["contents"],
  mentionName: string, // uri for the resource
): ChatMessage["parts"] {
  const parts: ChatMessage["parts"] = [];

  for (const content of contents) {
    if ("text" in content && content.text) {
      parts.push({
        type: "text",
        text: `[${mentionName}]\n${content.text}`,
      });
    } else if ("blob" in content && content.blob && content.mimeType) {
      parts.push({
        type: "file",
        url: `data:${content.mimeType};base64,${content.blob}`,
        filename: String(content.uri),
        mediaType: String(content.mimeType),
      });
    }
  }

  return parts;
}

/**
 * Converts prompt messages to UI message parts
 */
function promptMessagesToParts(
  messages: PromptMessage[],
  mentionName: string,
): ChatMessage["parts"] {
  const parts: ChatMessage["parts"] = [];

  // Process MCP prompt messages and extract content
  for (const message of messages) {
    if (message.role !== "user" || !message.content) continue;

    const messageContents = Array.isArray(message.content)
      ? message.content
      : [message.content];

    for (const content of messageContents) {
      switch (content.type) {
        case "text": {
          const text = content.text?.trim();
          if (!text) {
            continue;
          }

          parts.push({
            type: "text",
            text: `[${mentionName}]\n${text}`,
          });
          break;
        }
        case "image":
        case "audio": {
          if (!content.data || !content.mimeType) {
            continue;
          }

          parts.push({
            type: "file",
            url: `data:${content.mimeType};base64,${content.data}`,
            mediaType: content.mimeType,
          });

          break;
        }
        case "resource": {
          const resource = content.resource as
            | EmbeddedResource["resource"]
            | undefined;

          if (!resource || !resource.mimeType) {
            continue;
          }

          if (resource) {
            if ("text" in resource && resource.text) {
              parts.push({
                type: "text",
                text: `[${mentionName}]\n${resource.text}`,
              });
            } else if (
              "blob" in resource &&
              resource.blob &&
              resource.mimeType
            ) {
              parts.push({
                type: "file",
                url: `data:${resource.mimeType};base64,${resource.blob}`,
                filename: String(resource.uri),
                mediaType: String(resource.mimeType),
              });
            }
          }
          break;
        }
      }
    }
  }

  return parts;
}

/**
 * Converts file attributes to UI message parts
 * Text files are decoded and returned as text parts, others as file parts
 */
function fileAttrsToParts(
  fileAttrs: FileAttrs,
  mentionName: string,
): ChatMessage["parts"] {
  const { mimeType, data } = fileAttrs;

  // Text files: decode base64 and return as text part
  if (mimeType.startsWith("text/")) {
    try {
      const decodedText = atob(data);
      return [
        {
          type: "text",
          text: `${mentionName}\n${decodedText}`,
        },
      ];
    } catch (error) {
      console.error("Failed to decode text file:", error);
      // Fall through to file part if decoding fails
    }
  }

  // Non-text files: return as file part
  return [
    {
      type: "file",
      url: `data:${mimeType};base64,${data}`,
      filename: mentionName,
      mediaType: mimeType,
    },
  ];
}

/**
 * Helper to derive UI parts from TiptapDoc
 * Walks the tiptap document to extract inline text and collect resources from prompt tags
 */
function derivePartsFromTiptapDoc(
  doc: Metadata["tiptapDoc"],
): ChatMessage["parts"] {
  if (!doc) return [];

  const parts: ChatMessage["parts"] = [];
  let inlineText = "";

  // Walk the tiptap document to build inline text and collect resources
  const walkNode = (
    node:
      | Metadata["tiptapDoc"]
      | {
          type: string;
          attrs?: Record<string, unknown>;
          content?: unknown[];
          text?: string;
        },
  ) => {
    if (!node) return;

    if (
      node.type === "text" &&
      "text" in node &&
      typeof node.text === "string"
    ) {
      inlineText += node.text;
    } else if (node.type === "mention" && node.attrs) {
      const char = (node.attrs.char as string | undefined) ?? "/";
      const mentionName = `${char}${node.attrs.name}`;

      // Add label to inline text
      inlineText += mentionName;

      // Handle resource mentions (@) vs prompt mentions (/)
      if (char === "@") {
        // Resource mentions: metadata contains ReadResourceResult.contents directly
        const contents = (node.attrs.metadata ||
          []) as ReadResourceResult["contents"];
        parts.push(...resourcesToParts(contents, mentionName));
      } else {
        // Prompt mentions: metadata contains PromptMessage[]
        const prompts = (node.attrs.metadata ||
          node.attrs.prompts ||
          []) as PromptMessage[];
        parts.push(...promptMessagesToParts(prompts, mentionName));
      }
    } else if (node.type === "file" && node.attrs) {
      const fileAttrs = node.attrs as unknown as FileAttrs;
      const mentionName = `[file:://${encodeURIComponent(fileAttrs.name)}]`;

      inlineText += mentionName;

      parts.push(...fileAttrsToParts(fileAttrs, mentionName));
    }

    // Recursively walk content
    if ("content" in node && Array.isArray(node.content)) {
      for (const child of node.content) {
        walkNode(child as typeof node);
      }
    }
  };

  walkNode(doc);

  // Add inline text as first part if there is any
  if (inlineText.trim()) {
    parts.unshift({ type: "text", text: inlineText.trim() });
  }

  return parts;
}

const ChatStableContext = createContext<ChatStableValue | null>(null);
const ChatStreamContext = createContext<ChatStreamValue | null>(null);

const SAFETY_NET_POLL_MS = 30_000;
const getSnapshot = () => 0;

interface TaskStreamManagerProps {
  taskId: string;
  activeTask: Task | undefined;
  isStreaming: boolean;
  chatRef: React.RefObject<UseChatHelpers<ChatMessage>>;
  queryClient: QueryClient;
  locator: ProjectLocator;
  orgId: string;
}

/**
 * Behavior-only component managing stream resumption and safety-net polling.
 * Keyed by activeTaskId so it remounts on task switch — all refs start fresh.
 *
 * Resume should only happen when the server has an in-progress run but the
 * client has no active stream (page reload, tab switch, multi-pod). When the
 * client already has a live stream (from sendMessage or a previous resume),
 * SSE step events are just echoes — calling resumeStream would open a second
 * /attach connection and cause duplicate/oscillating chunks.
 */
function TaskStreamManager({
  taskId,
  activeTask,
  isStreaming,
  chatRef,
  queryClient,
  locator,
  orgId,
}: TaskStreamManagerProps) {
  const hasResumedRef = useRef<string | null>(null);
  const resumeFailCountRef = useRef(0);
  const MAX_RESUME_RETRIES = 3;

  const invalidateTaskList = () => {
    queryClient.invalidateQueries({ queryKey: KEYS.tasks(locator) });
  };

  const invalidateMessages = () => {
    if (!taskId) return;
    queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        if (key[3] !== "collection" || key[4] !== "THREAD_MESSAGES") {
          return false;
        }
        const serialized = typeof key[6] === "string" ? key[6] : "";
        return serialized.includes(taskId);
      },
    });
  };

  /** Read the AI SDK's live status — not the React-lagged prop. */
  const isChatActive = () => {
    const s = chatRef.current.status;
    return s === "submitted" || s === "streaming";
  };

  const tryResumeStream = (reason: string) => {
    if (!taskId || hasResumedRef.current === taskId) return;
    if (resumeFailCountRef.current >= MAX_RESUME_RETRIES) return;
    if (isChatActive()) return;
    hasResumedRef.current = taskId;

    console.log(`[chat] resumeStream (${reason})`, taskId);
    chatRef.current.resumeStream().catch((err: unknown) => {
      console.error("[chat] resumeStream error", err);
      resumeFailCountRef.current++;
      hasResumedRef.current = null;
      invalidateTaskList();
      invalidateMessages();
    });
  };

  useDecopilotEvents({
    orgId,
    taskId,
    onStep: () => tryResumeStream("sse-step"),
    onFinish: () => {
      // Only reset the resume guard when the AI SDK is truly idle.
      // During sendAutomaticallyWhen cycles the SDK fires onFinish
      // between round-trips while status is still "submitted" — resetting
      // here would re-open the window for a duplicate attach.
      if (!isChatActive()) {
        hasResumedRef.current = null;
        resumeFailCountRef.current = 0;
        invalidateTaskList();
        // Delay message invalidation so the server-side onFinish has time
        // to persist messages. Without this, the refetch races with the
        // server save and returns stale data — wiping the snapshot that
        // cancelRun or the client onFinish already wrote to the cache.
        setTimeout(invalidateMessages, 2000);
      }
    },
    onTaskStatus: () => {
      if (!isChatActive()) {
        invalidateTaskList();
      }
    },
  });

  const isRunInProgress =
    (activeTask?.status === "in_progress" ||
      activeTask?.status === "expired") &&
    !isStreaming;

  const subscribe = (_onStoreChange: () => void) => {
    if (!isRunInProgress) return () => {};

    tryResumeStream("page-load");

    const id = setInterval(() => {
      invalidateTaskList();
      invalidateMessages();
    }, SAFETY_NET_POLL_MS);
    return () => clearInterval(id);
  };

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return null;
}

/**
 * Provider component for chat context
 * Consolidates all chat-related state: interaction, tasks, virtual MCP, model, and chat session
 */
export function ChatProvider({ children }: PropsWithChildren) {
  // ===========================================================================
  // 1. HOOKS - Call all hooks and derive state from them
  // ===========================================================================

  const { locator, org } = useProjectContext();
  const queryClient = useQueryClient();
  const keys = useAiProviderKeyList();
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(
    keys[0]?.id ?? null,
  );
  const effectiveKeyId = keys.some((k) => k.id === selectedKeyId)
    ? selectedKeyId
    : (keys[0]?.id ?? null);

  // Unified task manager hook handles all task state and operations
  const taskManager = useTaskManager();

  // Project context
  // User session
  const { data: session } = authClient.useSession();
  const user = session?.user ?? null;
  // Preferences
  const [preferences] = usePreferences();
  // Chat state (reducer-based)
  const [chatState, chatDispatch] = useReducer(
    chatStateReducer,
    initialChatState,
  );

  // Shared ref for tiptapDoc — ChatInput owns the state, others read the ref.
  const tiptapDocRef = useRef<Metadata["tiptapDoc"]>(undefined);

  // App context injected by ext-apps via updateModelContext — stored in a ref
  // to avoid re-renders (only read at sendMessage time).
  const appContextsRef = useRef<Record<string, string>>({});

  // Keep a live ref to the current toolApprovalLevel so the transport's
  // prepareSendMessagesRequest can read the most-recent value even during
  // auto-sends that have no requestMetadata (e.g. after addToolApprovalResponse).
  const toolApprovalLevelRef = useRef<string | undefined>(
    preferences.toolApprovalLevel,
  );
  toolApprovalLevelRef.current = preferences.toolApprovalLevel;

  // Virtual MCP state
  const virtualMcps = useVirtualMCPs();
  const [storedSelectedVirtualMcpId, setSelectedVirtualMcpId] = useLocalStorage<
    string | null
  >(`${locator}:selected-virtual-mcp-id`, null);

  // Model state — filter out connections where the user's role allows no models
  const allModelsConnections = keys;
  const [storedModel, setModel] = useLocalStorage<AiProviderModel | null>(
    LOCALSTORAGE_KEYS.chatSelectedModel(locator),
    null,
  );

  // Load models for the effective key so we can auto-select a default.
  // useAiProviderModels uses a regular useQuery (non-suspending), so this
  // returns [] until data arrives — no blocking, no useEffect needed.
  const { models: defaultKeyModels, isLoading: isModelsQueryLoading } =
    useAiProviderModels(effectiveKeyId ?? undefined);
  const effectiveProviderId =
    keys.find((k) => k.id === effectiveKeyId)?.providerId ?? "";
  const defaultModel = selectDefaultModel(
    defaultKeyModels,
    effectiveProviderId,
    effectiveKeyId ?? undefined,
  );

  // Guard against stale localStorage entries that predate the current schema.
  // If required fields are missing the stored value is unusable — fall back to
  // the provider-aware default, then null.
  const hasValidStoredModel =
    !!storedModel &&
    typeof storedModel.modelId === "string" &&
    !!storedModel.title;
  const model = hasValidStoredModel ? storedModel! : defaultModel;

  // Only treat models as "loading" when we have no stored model to show yet.
  // If a valid stored model exists we render it immediately; no spinner needed.
  const isModelsLoading = !hasValidStoredModel && isModelsQueryLoading;

  // Mode state
  const [selectedMode, setSelectedMode] =
    useLocalStorage<ToolSelectionStrategy>(
      LOCALSTORAGE_KEYS.chatSelectedMode(locator),
      "code_execution",
    );

  // Messages are fetched by taskManager
  const initialMessages = taskManager.messages;

  // Context prompt
  const contextPrompt = useContextHook(storedSelectedVirtualMcpId);

  // Tool call handler
  const onToolCall = useInvalidateCollectionsOnToolCall();

  // Notification (sound + browser notification)
  const { showNotification } = useNotification();

  // ===========================================================================
  // 2. DERIVED VALUES - Compute values from hook state
  // ===========================================================================

  const selectedVirtualMcp = storedSelectedVirtualMcpId
    ? (virtualMcps.find((g) => g.id === storedSelectedVirtualMcpId) ?? null)
    : null;

  // Get decopilot ID for when no agent is explicitly selected (default agent)
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;

  const transport = createModelsTransport(org.slug, toolApprovalLevelRef);

  // ===========================================================================
  // 3. HOOK CALLBACKS - Functions passed to hooks
  // ===========================================================================

  const onFinish = async ({
    finishReason,
    isAbort,
    isDisconnect,
    isError,
    message,
    messages,
  }: {
    message: ChatMessage;
    messages: ChatMessage[];
    isAbort: boolean;
    isDisconnect: boolean;
    isError: boolean;
    finishReason?: string;
  }) => {
    chatDispatch({ type: "SET_FINISH_REASON", payload: finishReason ?? null });

    const serverTaskId = (message.metadata as Metadata | undefined)?.thread_id;
    const taskId = serverTaskId ?? taskManager.activeTaskId;

    // The server may assign a different thread ID than the client's optimistic
    // UUID (e.g. when a new thread is created with org-scoped storage). Sync
    // the active task to the server-assigned ID so subsequent message queries
    // target the correct thread instead of the empty optimistic one.
    if (serverTaskId && serverTaskId !== taskManager.activeTaskId) {
      taskManager.setActiveTaskId(serverTaskId);
    }

    if (isAbort || isDisconnect || isError) {
      // Persist partial messages so the UI doesn't flash back to stale
      // server data when the message source switches from chat.messages
      // to taskManager.messages (isStreaming -> false).
      if (taskId && messages.length > 0) {
        taskManager.updateMessagesCache(taskId, messages);
      }
      return;
    }

    if (!taskId) {
      return;
    }

    // Always persist streamed messages into the task cache so the UI
    // doesn't flash stale data when the message source switches from
    // chat.messages (streaming) to taskManager.messages (server).
    if (messages.length > 0) {
      taskManager.updateMessagesCache(taskId, messages);
    }

    // Show notification (sound + browser popup) if enabled
    if (preferences.enableNotifications) {
      showNotification({
        tag: `chat-${taskId}`,
        title: "Decopilot is waiting for your input at",
        body:
          taskManager.tasks.find((t) => t.id === taskId)?.title ?? "New chat",
      });
    }
  };

  const onError = (error: Error) => {
    console.error("[chat] Error", error);
  };

  // ===========================================================================
  // 4. HOOKS USING CALLBACKS - Hooks that depend on callback functions
  // ===========================================================================

  const chat = useAIChat<ChatMessage>({
    id: taskManager.activeTaskId,
    messages: initialMessages,
    transport,
    sendAutomaticallyWhen: ({ messages }) =>
      lastAssistantMessageIsCompleteWithToolCalls({ messages }) ||
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages }),
    onFinish,
    onToolCall,
    onError,
    onData: ({ data, type }) => {
      if (type === "data-thread-title") {
        const { title } = data;

        if (!title) {
          return;
        }

        taskManager.updateTask(taskManager.activeTaskId, {
          title,
          updated_at: new Date().toISOString(),
        });
      }
    },
  });

  // ===========================================================================
  // 5. POST-HOOK DERIVED VALUES - Values derived from hooks with callbacks
  // ===========================================================================

  const isStreaming =
    chat.status === "submitted" || chat.status === "streaming";

  // Computed from chat.messages (AI SDK's stable internal state) rather than
  // the source-switched `messages` which briefly becomes stale between
  // auto-send cycles, causing the warning banner to flicker.
  const isWaitingForApprovals = (() => {
    const last = chat.messages.at(-1);
    if (!last || last.role !== "assistant") return false;
    return last.parts.some(
      (part) => "state" in part && part.state === "approval-requested",
    );
  })();

  const isChatEmpty =
    chat.messages.length === 0 && taskManager.messages.length === 0;

  const activeTask = taskManager.tasks.find(
    (t) => t.id === taskManager.activeTaskId,
  );
  const isRunInProgress =
    (activeTask?.status === "in_progress" ||
      activeTask?.status === "expired") &&
    !isStreaming;

  // Ref so the SSE subscription handler can call resumeStream without
  // being re-created when `chat` changes (avoids unstable closure deps).
  const chatRef = useRef(chat);
  chatRef.current = chat;
  // Show real-time chat.messages during active streaming (local or resumed);
  // otherwise use server-sourced taskManager.messages.
  const messages = isStreaming
    ? chat.messages
    : (taskManager.messages as ChatMessage[]);

  // ===========================================================================
  // 6. RETURNED FUNCTIONS - Functions exposed via context
  // ===========================================================================

  // Task actions are provided by taskManager
  const createTask = () => {
    resetInteraction();
    taskManager.createTask();
  };
  const switchToTask = taskManager.switchToTask;
  const renameTask = taskManager.renameTask;
  const hideTask = taskManager.hideTask;

  // Chat state functions
  const resetInteraction = () => chatDispatch({ type: "RESET" });

  // Virtual MCP functions
  const setVirtualMcpId = (virtualMcpId: string | null) => {
    setSelectedVirtualMcpId(virtualMcpId);
  };

  // Model functions
  const setSelectedModel = (model: AiProviderModel) => {
    setModel({
      modelId: model.modelId,
      title: model.title,
      description: model.description,
      logo: model.logo,
      providerId: model.providerId,
      capabilities: model.capabilities,
      limits: model.limits,
      costs: model.costs,
      keyId: model.keyId,
    });
  };

  // App context functions
  const MAX_APP_CONTEXT_LENGTH = 10_000;
  const MAX_APP_CONTEXT_SOURCES = 10;

  const setAppContext = (
    sourceId: string,
    params: McpUiUpdateModelContextRequest["params"],
  ) => {
    const textParts: string[] = [];
    for (const block of params.content ?? []) {
      if (block.type === "text" && block.text?.trim()) {
        textParts.push(block.text.trim());
      }
    }
    const text = textParts.join("\n");

    if (!text) {
      delete appContextsRef.current[sourceId];
      return;
    }

    if (new TextEncoder().encode(text).length > MAX_APP_CONTEXT_LENGTH) return;
    if (
      Object.keys(appContextsRef.current).length >= MAX_APP_CONTEXT_SOURCES &&
      !(sourceId in appContextsRef.current)
    )
      return;

    appContextsRef.current[sourceId] = text;
  };

  const clearAppContext = (sourceId: string) => {
    delete appContextsRef.current[sourceId];
  };

  // Chat functions
  const sendMessage = async (tiptapDoc: Metadata["tiptapDoc"]) => {
    if (!model) {
      toast.error("No model configured");
      return;
    }

    const parts = derivePartsFromTiptapDoc(tiptapDoc);

    if (parts.length === 0) {
      return;
    }

    // Sync server-sourced messages into useAIChat before sending so its
    // internal state is current (needed for onFinish cache write-back and
    // sendAutomaticallyWhen checks on the response).
    if (taskManager.messages.length > 0) {
      chatRef.current.setMessages(taskManager.messages);
    }
    resetInteraction();

    const messageMetadata: Metadata = {
      tiptapDoc,
      created_at: new Date().toISOString(),
      thread_id: taskManager.activeTaskId,
      agent: {
        id: selectedVirtualMcp?.id ?? decopilotId,
        mode: selectedMode,
      },
      user: {
        avatar: user?.image ?? undefined,
        name: user?.name ?? "you",
      },
    };

    // Compose system prompt: route context + app contexts
    const appContextEntries = Object.entries(appContextsRef.current);
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

    await chatRef.current.sendMessage(userMessage, { metadata });
  };

  const cancelRun = async () => {
    const taskId = taskManager.activeTaskId;
    if (!taskId) return;

    // Snapshot streaming messages into the task cache BEFORE stopping.
    // When chat.stop() fires, isStreaming flips to false and the UI switches
    // from chat.messages to taskManager.messages — this preserves the
    // partial content generated up to the abort point.
    if (chatRef.current.messages.length > 0) {
      taskManager.updateMessagesCache(taskId, chatRef.current.messages);
    }

    chatRef.current.stop();
    try {
      const res = await fetch(`/api/${org.slug}/decopilot/cancel/${taskId}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(data.message ?? `Cancel failed: ${res.status}`);
      }
      await queryClient.invalidateQueries({ queryKey: KEYS.tasks(locator) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to cancel";
      toast.error(msg);
      console.error("[chat] cancelRun", err);
    }
  };

  const stop = (): void => {
    if (isStreaming) {
      void cancelRun();
    }
    chat.stop();
  };

  // Wrap for context: UseChatHelpers may expect () => Promise<void>
  const stopForContext = (): Promise<void> => {
    stop();
    return Promise.resolve();
  };

  const clearFinishReason = () => chatDispatch({ type: "CLEAR_FINISH_REASON" });

  // ===========================================================================
  // 7. CONTEXT VALUE & RETURN
  // ===========================================================================

  const deferredMessages = useDeferredValue(messages);

  const stableValue: ChatStableValue = {
    tiptapDocRef,
    resetInteraction,
    activeTaskId: taskManager.activeTaskId,
    tasks: taskManager.tasks,
    createTask,
    switchToTask,
    renameTask,
    hideTask,
    hasNextPage: taskManager.hasNextPage,
    isFetchingNextPage: taskManager.isFetchingNextPage,
    fetchNextPage: taskManager.fetchNextPage,
    ownerFilter: taskManager.ownerFilter,
    setOwnerFilter: taskManager.setOwnerFilter,
    isFilterChangePending: taskManager.isFilterChangePending,
    virtualMcps,
    selectedVirtualMcp,
    setVirtualMcpId,
    model,
    isModelsLoading,
    setSelectedModel,
    selectedMode,
    setSelectedMode,
    sendMessage,
    cancelRun,
    setAppContext,
    clearAppContext,
    allModelsConnections,
    credentialId: effectiveKeyId,
    setCredentialId: setSelectedKeyId,
  };

  const streamValue: ChatStreamValue = {
    messages: deferredMessages,
    status: chat.status,
    setMessages: chat.setMessages,
    error: chat.error,
    clearError: chat.clearError,
    stop: stopForContext,
    addToolOutput: chat.addToolOutput,
    addToolApprovalResponse: chat.addToolApprovalResponse,
    isStreaming,
    isChatEmpty,
    finishReason: chatState.finishReason,
    clearFinishReason,
    isWaitingForApprovals,
    isRunInProgress,
  };

  return (
    <ChatStableContext.Provider value={stableValue}>
      <ChatStreamContext.Provider value={streamValue}>
        <ErrorBoundary fallback={null}>
          <Suspense fallback={null}>
            <TaskStreamManager
              key={taskManager.activeTaskId}
              taskId={taskManager.activeTaskId}
              activeTask={activeTask}
              isStreaming={isStreaming}
              chatRef={chatRef}
              queryClient={queryClient}
              locator={locator}
              orgId={org.id}
            />
          </Suspense>
        </ErrorBoundary>
        {children}
      </ChatStreamContext.Provider>
    </ChatStableContext.Provider>
  );
}

/**
 * Stable chat values (model, mode, tasks, virtual MCP, actions).
 * Does NOT re-render during streaming.
 */
export function useChatStable() {
  const context = useContext(ChatStableContext);
  if (!context) {
    throw new Error("useChatStable must be used within a ChatProvider");
  }
  return context;
}

/**
 * Streaming chat values (messages, status, error, derived booleans).
 * Re-renders during streaming with deferred batching.
 */
function useChatStream() {
  const context = useContext(ChatStreamContext);
  if (!context) {
    throw new Error("useChatStream must be used within a ChatProvider");
  }
  return context;
}

/**
 * Full chat context (stable + stream merged).
 * Prefer useChatStable() or useChatStream() to reduce re-renders during streaming.
 */
export function useChat(): ChatContextValue {
  return { ...useChatStable(), ...useChatStream() };
}

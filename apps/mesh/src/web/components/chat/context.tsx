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
  useEffect,
  useReducer,
  useRef,
} from "react";
import { useDecopilotEvents } from "../../hooks/use-decopilot-events";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useModelConnections } from "../../hooks/collections/use-llm";
import { useAllowedModels } from "../../hooks/use-allowed-models";
import { useContext as useContextHook } from "../../hooks/use-context";
import { useInvalidateCollectionsOnToolCall } from "../../hooks/use-invalidate-collections-on-tool-call";
import { useLocalStorage } from "../../hooks/use-local-storage";
import { ErrorBoundary } from "../error-boundary";
import { useNotification } from "../../hooks/use-notification";
import { usePreferences } from "../../hooks/use-preferences";
import { authClient } from "../../lib/auth-client";
import { KEYS } from "../../lib/query-keys";
import { LOCALSTORAGE_KEYS } from "../../lib/localstorage-keys";
import { type ModelChangePayload, useModels } from "./select-model";
import type { VirtualMCPInfo } from "./select-virtual-mcp";
import { useTaskManager, type Task } from "./task";
import type { FileAttrs } from "./tiptap/file/node.tsx";
import type { ChatMessage, ChatModelsConfig, Metadata } from "./types.ts";
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

/**
 * Shape persisted in localStorage for the selected model.
 * Capabilities are stored so modelSupportsFiles works on reload
 * without a live fetch. Limits are stored so the API route gets
 * the correct maxOutputTokens on reload without a fresh model fetch.
 */
interface StoredModelState {
  id: string;
  connectionId: string;
  provider?: string;
  capabilities?: string[];
  limits?: { contextWindow?: number; maxOutputTokens?: number };
}

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

  virtualMcps: VirtualMCPInfo[];
  selectedVirtualMcp: VirtualMCPInfo | null;
  setVirtualMcpId: (virtualMcpId: string | null) => void;

  modelsConnections: ReturnType<typeof useModelConnections>;
  selectedModel: ChatModelsConfig | null;
  setSelectedModel: (model: ModelChangePayload) => void;

  selectedMode: ToolSelectionStrategy;
  setSelectedMode: (mode: ToolSelectionStrategy) => void;

  sendMessage: (tiptapDoc: Metadata["tiptapDoc"]) => Promise<void>;
  cancelRun: () => Promise<void>;
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
 * Find an item by id in an array, or return the first item, or null
 */
const findOrFirst = <T extends { id: string }>(array?: T[], id?: string) =>
  array?.find((item) => item.id === id) ?? array?.[0] ?? null;

/**
 * Hook to manage model selection state.
 * Builds ChatModelsConfig from localStorage only — no model fetching here.
 * Auto-selection is handled by ModelAutoSelector rendered in ChatProvider.
 */
const useModelState = (
  locator: ProjectLocator,
  modelsConnections: ReturnType<typeof useModelConnections>,
) => {
  const [modelState, setModelState] = useLocalStorage<StoredModelState | null>(
    LOCALSTORAGE_KEYS.chatSelectedModel(locator),
    null,
  );

  // Validate stored connectionId is still in the available connections list.
  // Falls back to first connection when stored one is gone.
  const modelsConnection = findOrFirst(
    modelsConnections,
    modelState?.connectionId,
  );

  // Reconstruct ChatModelsConfig from stored state — no fetch needed.
  // Note: `fast` (cheapest model) is intentionally not computed here since we no
  // longer fetch the full model list in this hook. It remains undefined until the
  // user explicitly picks a model. The fast field is advisory; it falls back to
  // `thinking` when absent.
  const selectedModelsConfig: ChatModelsConfig | null =
    modelState && modelsConnection
      ? {
          connectionId: modelsConnection.id,
          thinking: {
            id: modelState.id,
            provider: modelState.provider,
            capabilities: modelState.capabilities
              ? {
                  vision: modelState.capabilities.includes("vision")
                    ? true
                    : undefined,
                  text: modelState.capabilities.includes("text")
                    ? true
                    : undefined,
                  tools: modelState.capabilities.includes("tools")
                    ? true
                    : undefined,
                }
              : undefined,
            limits: modelState.limits,
          },
        }
      : null;

  return [selectedModelsConfig, setModelState] as const;
};

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

/**
 * Silent child component that auto-selects the first available model when
 * none is stored. Wrapped in ErrorBoundary + Suspense inside ChatProvider so
 * any MCP error (e.g. 401 from Gemini) is contained here and never propagates
 * to the parent provider or the page.
 *
 * Renders null — purely a behavior component.
 */
function ModelAutoSelector({
  modelsConnections,
  currentConfig,
  onAutoSelect,
  allowAll,
  isModelAllowed,
}: {
  modelsConnections: ReturnType<typeof useModelConnections>;
  currentConfig: ChatModelsConfig | null;
  onAutoSelect: (state: StoredModelState) => void;
  allowAll: boolean;
  isModelAllowed: (connectionId: string, modelId: string) => boolean;
}) {
  const firstConnection = modelsConnections[0];
  // This call may suspend (loading) or throw (MCP error).
  // Both are handled by the ErrorBoundary + Suspense wrapping this component.
  const models = useModels(firstConnection?.id);

  // useEffect is required here: writing localStorage during render would violate
  // React's render-purity requirement. We need a side effect that fires after
  // the component confirms models are available, then calls onAutoSelect once.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    // Only auto-select when there is no stored model config yet.
    if (currentConfig || !firstConnection || models.length === 0) return;

    // Filter models through the same permission check used in the manual
    // selector so auto-selection always picks a model the user can actually use.
    const allowedModels = allowAll
      ? models
      : models.filter((m) => isModelAllowed(firstConnection.id, m.id));

    // Prefer Claude Opus 4.6 as default, fall back to Sonnet 4.6, then any
    const preferred =
      allowedModels.find((m) => m.id.includes("claude-4.6-opus")) ??
      allowedModels.find((m) => m.id.includes("claude-opus-4.6")) ??
      allowedModels.find((m) => m.id.includes("claude-sonnet-4.6")) ??
      allowedModels.find((m) => m.id.includes("claude-sonnet"));
    const first = preferred ?? allowedModels[0];
    if (!first) return;
    onAutoSelect({
      id: first.id,
      connectionId: firstConnection.id,
      provider: first.provider ?? undefined,
      capabilities: first.capabilities ?? undefined,
      limits: first.limits ?? undefined,
    });
  }, [
    models,
    currentConfig,
    firstConnection,
    onAutoSelect,
    allowAll,
    isModelAllowed,
  ]);

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
  const allModelsConnections = useModelConnections();
  const { hasConnectionModels, isModelAllowed, allowAll } = useAllowedModels();
  const modelsConnections = allModelsConnections.filter((conn) =>
    hasConnectionModels(conn.id),
  );
  const [selectedModel, setModel] = useModelState(locator, modelsConnections);

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

    const taskId =
      (message.metadata as Metadata | undefined)?.thread_id ??
      taskManager.activeTaskId;

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
  const hasResumedRef = useRef<string | null>(null);
  const resumeFailCountRef = useRef(0);
  const MAX_RESUME_RETRIES = 3;

  const invalidateTaskData = () => {
    queryClient.invalidateQueries({ queryKey: KEYS.tasks(locator) });
    const tid = taskManager.activeTaskId;
    if (tid) {
      queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey;
          if (key[3] !== "collection" || key[4] !== "THREAD_MESSAGES") {
            return false;
          }
          const serialized = typeof key[6] === "string" ? key[6] : "";
          return serialized.includes(tid);
        },
      });
    }
  };

  // Resume an in-progress stream via the AI SDK's transport.reconnectToStream
  // (GET /attach/:taskId → JetStream replay).  The SDK handles all internal
  // message state: status flips to "streaming", chat.messages updates live.
  const tryResumeStream = (reason: string) => {
    const tid = taskManager.activeTaskId;
    if (!tid || hasResumedRef.current === tid) return;
    if (resumeFailCountRef.current >= MAX_RESUME_RETRIES) return;
    hasResumedRef.current = tid;

    console.log(`[chat] resumeStream (${reason})`, tid);
    chatRef.current.resumeStream().catch((err: unknown) => {
      console.error("[chat] resumeStream error", err);
      resumeFailCountRef.current++;
      hasResumedRef.current = null;
      invalidateTaskData();
    });
  };

  const invalidateTaskDataRef = useRef(invalidateTaskData);
  invalidateTaskDataRef.current = invalidateTaskData;

  const tryResumeStreamRef = useRef(tryResumeStream);
  tryResumeStreamRef.current = tryResumeStream;

  useDecopilotEvents({
    orgId: org.id,
    taskId: taskManager.activeTaskId,
    onStep: () => tryResumeStream("sse-step"),
    onFinish: () => {
      hasResumedRef.current = null;
      resumeFailCountRef.current = 0;
      if (!isStreaming) {
        invalidateTaskData();
      }
    },
    onTaskStatus: () => {
      if (!isStreaming) {
        invalidateTaskData();
      }
    },
  });

  // Reset resume state when switching tasks so failures from one task
  // don't block resume attempts on a different task.
  // Done during render (not in useEffect) to avoid React strict-mode
  // double-mount resetting the guard and firing duplicate attach requests.
  const prevActiveTaskIdRef = useRef(taskManager.activeTaskId);
  if (prevActiveTaskIdRef.current !== taskManager.activeTaskId) {
    prevActiveTaskIdRef.current = taskManager.activeTaskId;
    hasResumedRef.current = null;
    resumeFailCountRef.current = 0;
  }

  // Trigger resume on page load / task switch when a background run is active.
  // Also safety-net poll in case SSE events are missed (NATS at-most-once).
  const SAFETY_NET_POLL_MS = 30_000;
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (!isRunInProgress) return;

    tryResumeStreamRef.current("page-load");

    invalidateTaskDataRef.current();
    const safetyId = setInterval(
      () => invalidateTaskDataRef.current(),
      SAFETY_NET_POLL_MS,
    );

    return () => {
      clearInterval(safetyId);
    };
  }, [isRunInProgress]);

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
  const setSelectedModel = (model: ModelChangePayload) => {
    setModel({
      id: model.id,
      connectionId: model.connectionId,
      provider: model.provider,
      capabilities: model.capabilities,
      limits: model.limits,
    });
  };

  // Chat functions
  const sendMessage = async (tiptapDoc: Metadata["tiptapDoc"]) => {
    if (!selectedModel) {
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

    const metadata: Metadata = {
      ...messageMetadata,
      system: contextPrompt,
      models: selectedModel,
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
    hasResumedRef.current = null;
    resumeFailCountRef.current = 0;

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
    virtualMcps,
    selectedVirtualMcp,
    setVirtualMcpId,
    modelsConnections,
    selectedModel,
    setSelectedModel,
    selectedMode,
    setSelectedMode,
    sendMessage,
    cancelRun,
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
            <ModelAutoSelector
              modelsConnections={modelsConnections}
              currentConfig={selectedModel}
              onAutoSelect={setModel}
              allowAll={allowAll}
              isModelAllowed={isModelAllowed}
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

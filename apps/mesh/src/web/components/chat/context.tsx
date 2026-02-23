/**
 * Chat Context
 *
 * Manages chat interaction, thread management, virtual MCP/model selection, and chat session state.
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
  useEffect,
  useReducer,
} from "react";
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
import { LOCALSTORAGE_KEYS } from "../../lib/localstorage-keys";
import { type ModelChangePayload, useModels } from "./select-model";
import type { VirtualMCPInfo } from "./select-virtual-mcp";
import { useThreadManager } from "./thread";
import type { FileAttrs } from "./tiptap/file/node.tsx";
import type {
  ChatMessage,
  ChatModelsConfig,
  Metadata,
  ParentThread,
  Thread,
} from "./types.ts";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * State shape for chat state (reducer-managed)
 */
export interface ChatState {
  /** Tiptap document representing the current input (source of truth) */
  tiptapDoc: Metadata["tiptapDoc"];
  /** Active parent thread if branching is in progress */
  parentThread: ParentThread | null;
  /** Finish reason from the last chat completion */
  finishReason: string | null;
}

/**
 * Actions for the chat state reducer
 */
export type ChatStateAction =
  | { type: "SET_TIPTAP_DOC"; payload: Metadata["tiptapDoc"] }
  | { type: "CLEAR_TIPTAP_DOC" }
  | { type: "START_BRANCH"; payload: ParentThread }
  | { type: "CLEAR_BRANCH" }
  | { type: "SET_FINISH_REASON"; payload: string | null }
  | { type: "CLEAR_FINISH_REASON" }
  | { type: "RESET" };

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
 * Combined context value including interaction state, thread management, and session state
 */
interface ChatContextValue extends ChatFromUseChat {
  // Interaction state
  tiptapDoc: Metadata["tiptapDoc"];
  setTiptapDoc: (doc: Metadata["tiptapDoc"]) => void;
  clearTiptapDoc: () => void;
  resetInteraction: () => void;

  // Thread management
  activeThreadId: string;
  createThread: () => void; // For creating new threads (with prefetch)
  switchToThread: (threadId: string) => Promise<void>; // For switching with cache prefilling
  threads: Thread[];
  hideThread: (threadId: string) => void;

  // Thread pagination (for infinite scroll)
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  fetchNextPage?: () => void;

  // Virtual MCP state
  virtualMcps: VirtualMCPInfo[];
  selectedVirtualMcp: VirtualMCPInfo | null;
  setVirtualMcpId: (virtualMcpId: string | null) => void;

  // Model state
  modelsConnections: ReturnType<typeof useModelConnections>;
  selectedModel: ChatModelsConfig | null;
  setSelectedModel: (model: ModelChangePayload) => void;

  // Mode state
  selectedMode: ToolSelectionStrategy;
  setSelectedMode: (mode: ToolSelectionStrategy) => void;

  // Chat state (extends useChat; sendMessage overridden, isStreaming/isChatEmpty derived)
  sendMessage: (tiptapDoc: Metadata["tiptapDoc"]) => Promise<void>;
  isStreaming: boolean;
  isChatEmpty: boolean;
  finishReason: string | null;
  clearFinishReason: () => void;
}

// ============================================================================
// Implementation
// ============================================================================

const createModelsTransport = (
  org: string,
): DefaultChatTransport<UIMessage<Metadata>> =>
  new DefaultChatTransport<UIMessage<Metadata>>({
    api: `/api/${org}/decopilot/stream`,
    credentials: "include",
    prepareSendMessagesRequest: ({ messages, requestMetadata = {} }) => {
      const {
        system,
        tiptapDoc: _tiptapDoc,
        toolApprovalLevel,
        ...metadata
      } = requestMetadata as Metadata & { toolApprovalLevel?: string };
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

      // Fall back to last message metadata when requestMetadata is missing models/agent
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
          ...(toolApprovalLevel && { toolApprovalLevel }),
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
 * Initial chat state
 */
const initialChatState: ChatState = {
  tiptapDoc: undefined,
  parentThread: null,
  finishReason: null,
};

/**
 * Reducer for chat state
 */
function chatStateReducer(
  state: ChatState,
  action: ChatStateAction,
): ChatState {
  switch (action.type) {
    case "SET_TIPTAP_DOC":
      return { ...state, tiptapDoc: action.payload };
    case "CLEAR_TIPTAP_DOC":
      return { ...state, tiptapDoc: undefined };
    case "START_BRANCH":
      return { ...state, parentThread: action.payload };
    case "CLEAR_BRANCH":
      return { ...state, parentThread: null };
    case "SET_FINISH_REASON":
      return { ...state, finishReason: action.payload };
    case "CLEAR_FINISH_REASON":
      return { ...state, finishReason: null };
    case "RESET":
      return initialChatState;
    default:
      return state;
  }
}

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

const ChatContext = createContext<ChatContextValue | null>(null);

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

    const first = allowedModels[0];
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
 * Consolidates all chat-related state: interaction, threads, virtual MCP, model, and chat session
 */
export function ChatProvider({ children }: PropsWithChildren) {
  // ===========================================================================
  // 1. HOOKS - Call all hooks and derive state from them
  // ===========================================================================

  const { locator, org } = useProjectContext();

  // Unified thread manager hook handles all thread state and operations
  const threadManager = useThreadManager();

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

  // Messages are fetched by threadManager
  const initialMessages = threadManager.messages;

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

  const transport = createModelsTransport(org.slug);

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

    if (isAbort || isDisconnect || isError) {
      return;
    }

    const { thread_id } = message.metadata ?? {};

    if (!thread_id) {
      return;
    }

    // Show notification (sound + browser popup) if enabled
    if (preferences.enableNotifications) {
      showNotification({
        tag: `chat-${thread_id}`,
        title: "Decopilot is waiting for your input at",
        body:
          threadManager.threads.find((t) => t.id === thread_id)?.title ??
          "New chat",
      });
    }

    if (finishReason !== "stop") {
      return;
    }

    // Update messages cache with the latest messages from the stream
    threadManager.updateMessagesCache(thread_id, messages);
  };

  const onError = (error: Error) => {
    console.error("[chat] Error", error);
  };

  // ===========================================================================
  // 4. HOOKS USING CALLBACKS - Hooks that depend on callback functions
  // ===========================================================================

  const chat = useAIChat<ChatMessage>({
    id: threadManager.activeThreadId,
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

        threadManager.updateThread(threadManager.activeThreadId, {
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

  const isChatEmpty = chat.messages.length === 0;

  // ===========================================================================
  // 6. RETURNED FUNCTIONS - Functions exposed via context
  // ===========================================================================

  // Thread actions are provided by threadManager
  const createThread = () => {
    resetInteraction();
    threadManager.createThread();
  };
  const switchToThread = threadManager.switchThread;
  const hideThread = threadManager.hideThread;

  // Chat state functions
  const setTiptapDoc = (doc: Metadata["tiptapDoc"]) =>
    chatDispatch({ type: "SET_TIPTAP_DOC", payload: doc });

  const clearTiptapDoc = () => chatDispatch({ type: "CLEAR_TIPTAP_DOC" });

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

    resetInteraction();

    const messageMetadata: Metadata = {
      tiptapDoc,
      created_at: new Date().toISOString(),
      thread_id: threadManager.activeThreadId,
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
      toolApprovalLevel: preferences.toolApprovalLevel,
    };

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts,
      metadata: messageMetadata,
    };

    await chat.sendMessage(userMessage, { metadata });
  };

  const stop = () => chat.stop();

  const clearFinishReason = () => chatDispatch({ type: "CLEAR_FINISH_REASON" });

  // ===========================================================================
  // 7. CONTEXT VALUE & RETURN
  // ===========================================================================

  const value: ChatContextValue = {
    // Chat state
    tiptapDoc: chatState.tiptapDoc,
    setTiptapDoc,
    clearTiptapDoc,
    resetInteraction,

    // Thread management (using threadManager)
    activeThreadId: threadManager.activeThreadId,
    threads: threadManager.threads,
    createThread,
    switchToThread,
    hideThread,

    // Thread pagination
    hasNextPage: threadManager.hasNextPage,
    isFetchingNextPage: threadManager.isFetchingNextPage,
    fetchNextPage: threadManager.fetchNextPage,

    // Virtual MCP state
    virtualMcps,
    selectedVirtualMcp,
    setVirtualMcpId,

    // Model state
    modelsConnections,
    selectedModel,
    setSelectedModel,

    // Mode state
    selectedMode,
    setSelectedMode,

    // Chat session state (from useChat)
    messages: chat.messages,
    status: chat.status,
    setMessages: chat.setMessages,
    error: chat.error,
    clearError: chat.clearError,
    stop,
    addToolOutput: chat.addToolOutput,
    addToolApprovalResponse: chat.addToolApprovalResponse,
    sendMessage,
    isStreaming,
    isChatEmpty,
    finishReason: chatState.finishReason,
    clearFinishReason,
  };

  return (
    <ChatContext.Provider value={value}>
      {/* Auto-selects first model when none is stored.
          ErrorBoundary ensures MCP errors (e.g. auth failures) never crash the provider. */}
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
    </ChatContext.Provider>
  );
}

/**
 * Hook to access the full chat context
 * Returns interaction state, thread management, virtual MCP, model, and chat session state
 */
export function useChat() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChat must be used within a ChatProvider");
  }
  return context;
}

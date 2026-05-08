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
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useChat as useAIChat, type UseChatHelpers } from "@ai-sdk/react";
import {
  AUTOSEND_QUERY_VALUE,
  claimStoredAutosend,
  clearStoredAutosend,
  writeStoredAutosend,
} from "@/web/lib/autosend";
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
  type AiProviderKey,
  type AiProviderModel,
} from "../../hooks/collections/use-ai-providers";
import { useContext as useContextHook } from "../../hooks/use-context";
import {
  usePreferences,
  readToolApprovalLevel,
} from "../../hooks/use-preferences";
import { useInvalidateCollectionsOnToolCall } from "../../hooks/use-invalidate-collections-on-tool-call";
import { useTaskReadState } from "../../hooks/use-task-read-state";
import { authClient } from "../../lib/auth-client";
import { track } from "../../lib/posthog-client";

// Module-level set so a given chat fires `chat_opened` at most once per page
// session per thread_id. Prevents duplicates from re-renders while still
// re-firing when the user switches tasks.
const openedChats = new Set<string>();
import { toMetadataModelInfo } from "../../lib/metadata-model-info";

import { useChatNavigation } from "./hooks/use-chat-navigation";
import { useStreamManager } from "./hooks/use-stream-manager";
import { useTaskActions } from "../../hooks/use-tasks";
import { useTaskManager, type TaskOwnerFilter } from "./task";
import { useTaskMessages } from "./task/use-task-manager";
import { derivePartsFromTiptapDoc } from "./derive-parts";
import type { VirtualMCPInfo } from "./select-virtual-mcp";
import type { ChatMessage, ChatMode, Metadata } from "./types";
import type { Task } from "./task/types";
import type {
  FinishPayload,
  SendMessageParams,
  SetAppContextParams,
} from "./store/types";
import { useLocalStorage } from "../../hooks/use-local-storage";
import { chatModeForTransportRef } from "../../lib/chat-mode-sync";
import { LOCALSTORAGE_KEYS } from "../../lib/localstorage-keys";
import { KEYS } from "../../lib/query-keys";
import { useSimpleMode } from "../../hooks/use-organization-settings";

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
  /** thread.branch — the only source of truth. Null until the user picks one or the server generates one on first send. */
  currentBranch: string | null;
  /**
   * Immutable once set: switching branches mid-conversation would reroute the
   * thread's vmMap entry, so users must create a new thread for another branch.
   */
  isBranchLocked: boolean;
  /** Persist pinned branch onto the thread (cache + server). */
  setCurrentTaskBranch: (branch: string | null) => void;
  ownerFilter: TaskOwnerFilter;
  setOwnerFilter: (filter: TaskOwnerFilter) => void;
  isFilterChangePending: boolean;
}

export interface ChatPrefsContextValue {
  selectedModel: AiProviderModel | null;
  setModel: (model: AiProviderModel) => void;
  credentialId: string | null;
  setCredentialId: (id: string | null) => void;
  allModelsConnections: ReturnType<typeof useAiProviderKeys>;
  isModelsLoading: boolean;
  selectedVirtualMcp: VirtualMCPInfo | null;
  /** Selected image generation model (null = no image models available) */
  imageModel: AiProviderModel | null;
  setImageModel: (model: AiProviderModel | null) => void;
  /** Selected deep research model (null = no deep research models available) */
  deepResearchModel: AiProviderModel | null;
  setDeepResearchModel: (model: AiProviderModel | null) => void;
  /** Chat mode for the next send — plan, web-search, gen-image, or default */
  chatMode: ChatMode;
  setChatMode: (mode: ChatMode) => void;
  appContexts: Record<string, string>;
  setAppContext: (sourceId: string, params: SetAppContextParams) => void;
  clearAppContext: (sourceId: string) => void;
  tiptapDoc: Metadata["tiptapDoc"];
  setTiptapDoc: (doc: Metadata["tiptapDoc"]) => void;
  /** @deprecated Use tiptapDoc directly */
  tiptapDocRef: { current: Metadata["tiptapDoc"] };
  /** @deprecated No-op */
  resetInteraction: () => void;
  /** Whether Simple Model Mode is enabled for the org */
  simpleModeEnabled: boolean;
  /** The currently selected tier in Simple Model Mode */
  simpleModeTier: "fast" | "smart" | "thinking";
  setSimpleModeTier: (tier: "fast" | "smart" | "thinking") => void;
}

export interface ChatBridgeValue {
  sendMessage: (params: SendMessageParams) => Promise<void>;
  isStreaming: boolean;
}

// ============================================================================
// Model resolution helpers (shared across chat / image / deep-research paths)
// ============================================================================

type ModelRef = { keyId: string; modelId: string };
type SimpleTier = "fast" | "smart" | "thinking";

/**
 * Resolve a stored ModelRef against the currently available keys and models.
 * Returns null when the ref's key no longer exists. Match is by `modelId`
 * only within `allModels` — the API-returned model objects don't carry
 * `keyId` (it's a client-side-only field), so we attach it ourselves.
 * When the model isn't in the provided list (list still loading, or list
 * scoped to a different credential), synthesize a minimal AiProviderModel
 * from the ref so callers always get a routable `{ keyId, modelId }`.
 */
function findModel(
  ref: ModelRef | null,
  allKeys: AiProviderKey[],
  allModels: AiProviderModel[],
  title?: string,
): AiProviderModel | null {
  if (!ref) return null;
  const key = allKeys.find((k) => k.id === ref.keyId);
  if (!key) return null;
  const hit = allModels.find((m) => m.modelId === ref.modelId);
  if (hit) return { ...hit, keyId: ref.keyId };
  return {
    modelId: ref.modelId,
    title: title ?? ref.modelId,
    keyId: ref.keyId,
    providerId: key.providerId,
    description: null,
    logo: null,
    capabilities: [],
    limits: null,
    costs: null,
  } as AiProviderModel;
}

/**
 * Pick the active Simple Mode tier, validated against the current config.
 * Handles the case where the stored tier is orphaned (slot unset or Simple
 * Mode changed server-side). Falls through to the first configured tier.
 */
function resolveActiveTier(
  stored: SimpleTier | null,
  simpleMode: { chat: Record<SimpleTier, unknown> },
): SimpleTier {
  const configured = (["fast", "smart", "thinking"] as const).filter(
    (t) => simpleMode.chat[t] != null,
  );
  if (stored && configured.includes(stored)) return stored;
  if (configured.includes("smart")) return "smart";
  return configured[0] ?? "smart";
}

// ============================================================================
// Constants
// ============================================================================

const MAX_APP_CONTEXT_LENGTH = 10_000;
const MAX_APP_CONTEXT_SOURCES = 10;

const BRIDGE_NOOP: ChatBridgeValue = {
  sendMessage: async () => {
    console.warn(
      "[ChatBridge] sendMessage called but ActiveTaskProvider not mounted",
    );
  },
  isStreaming: false,
};

/** Internal-only type for cross-provider communication */
interface TaskProviderInternals {
  transport: DefaultChatTransport<UIMessage<Metadata>>;
  effectiveKeyId: string | null;
  user: { image?: string | null; name?: string } | null;
  contextPrompt: string;
  preferences: {
    toolApprovalLevel?: import("../../hooks/use-preferences").ToolApprovalLevel;
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
/**
 * ChatBridgeCtx holds a RefObject (not a value) so consumers outside
 * ActiveTaskProvider always read the latest sendMessage/isStreaming via
 * `.current` at call time — avoids stale closures when ActiveTaskProvider
 * mutates the ref after initial render.
 */
const ChatBridgeCtx = createContext<React.RefObject<ChatBridgeValue>>({
  current: BRIDGE_NOOP,
});

/** Internal context for passing TaskProvider internals to ActiveTaskProvider */
const TaskInternalsCtx = createContext<TaskProviderInternals | null>(null);

// ============================================================================
// ChatPrefsProvider — standalone-mountable prefs context
// ============================================================================

/**
 * Mounts the prefs context (model/agent/mode selection) without the rest
 * of the chat infrastructure. Use on routes that have a chat composer but
 * no active stream — currently `/$org/`. Localstorage-backed selections
 * (chat model, image model, deep research model, simple-mode tier) sync
 * automatically with any other mount of this provider via storage events.
 *
 * `virtualMcpId` is derived from the URL search param (`virtualmcpid`) with
 * a decopilot fallback, matching `useChatNavigation` — so the same
 * provider works on `/$org/` and `/$org/$taskId`.
 *
 * On routes that mount `ChatContextProvider`, that wrapper internally
 * mounts its own `ChatPrefsCtx.Provider` for backwards compatibility; the
 * inner mount shadows this one. Persistent state still syncs via
 * localStorage; transient state (chatMode, tiptapDoc, appContexts) is
 * scoped to whichever mount the consumer is reading from — fine for our
 * flows because home submit clears the editor and the task page starts
 * fresh.
 */
export function ChatPrefsProvider({ children }: PropsWithChildren) {
  const { locator } = useProjectContext();
  const { virtualMcpId: urlVirtualMcpId } = useChatNavigation();

  // Model selection (localStorage-backed)
  const [storedChatRef, setStoredChatRef] = useLocalStorage<ModelRef | null>(
    LOCALSTORAGE_KEYS.chatSelectedModel(locator),
    null,
  );
  const [storedImageRef, setStoredImageRef] = useLocalStorage<ModelRef | null>(
    LOCALSTORAGE_KEYS.chatSelectedImageModel(locator),
    null,
  );
  const [storedDeepResearchRef, setStoredDeepResearchRef] =
    useLocalStorage<ModelRef | null>(
      LOCALSTORAGE_KEYS.chatSelectedDeepResearchModel(locator),
      null,
    );

  const [sessionCredentialId, setSessionCredentialId] = useState<string | null>(
    null,
  );

  const [chatMode, setChatMode] = useState<ChatMode>("default");
  chatModeForTransportRef.current = chatMode;

  // Simple Model Mode
  const simpleMode = useSimpleMode();
  const [storedTier, setStoredTier] = useLocalStorage<SimpleTier | null>(
    LOCALSTORAGE_KEYS.chatSimpleModeTier(locator),
    null,
  );
  const activeTier = resolveActiveTier(storedTier, simpleMode);

  // AI provider keys + models
  const keys = useAiProviderKeys();
  const effectiveKeyId =
    sessionCredentialId && keys.some((k) => k.id === sessionCredentialId)
      ? sessionCredentialId
      : storedChatRef && keys.some((k) => k.id === storedChatRef.keyId)
        ? storedChatRef.keyId
        : (keys[0]?.id ?? null);
  const { models: allKeyModels, isLoading: isModelsQueryLoading } =
    useAiProviderModels(effectiveKeyId ?? undefined);
  const effectiveProviderId =
    keys.find((k) => k.id === effectiveKeyId)?.providerId ?? "anthropic";
  const defaultModel = selectDefaultModel(
    allKeyModels,
    effectiveProviderId,
    effectiveKeyId ?? undefined,
  );

  const activeChatSlot = simpleMode.chat[activeTier];
  const { models: simpleChatModels } = useAiProviderModels(
    activeChatSlot?.keyId,
  );
  const { models: simpleImageModels } = useAiProviderModels(
    simpleMode.image?.keyId,
  );
  const { models: simpleWebResearchModels } = useAiProviderModels(
    simpleMode.webResearch?.keyId,
  );

  const validatedStoredChat = findModel(storedChatRef, keys, allKeyModels);
  const selectedModel: AiProviderModel | null = simpleMode.enabled
    ? findModel(activeChatSlot, keys, simpleChatModels, activeChatSlot?.title)
    : (validatedStoredChat ?? defaultModel);
  const isModelsLoading = !storedChatRef && isModelsQueryLoading;

  const imageModels = allKeyModels.filter((m) =>
    m.capabilities?.includes("image"),
  );
  const validatedStoredImage = findModel(storedImageRef, keys, imageModels);
  const resolvedImageModel: AiProviderModel | null = simpleMode.enabled
    ? findModel(
        simpleMode.image,
        keys,
        simpleImageModels,
        simpleMode.image?.title,
      )
    : (validatedStoredImage ?? imageModels[0] ?? null);

  const deepResearchModels = allKeyModels.filter((m) => {
    const n = m.modelId.toLowerCase().replace(/[^a-z0-9]/g, "");
    return n.includes("sonar") || n.includes("deepresearch");
  });
  const validatedStoredDeepResearch = findModel(
    storedDeepResearchRef,
    keys,
    deepResearchModels,
  );
  const defaultDeepResearchModel =
    deepResearchModels.find((m) => m.modelId === "perplexity/sonar") ??
    deepResearchModels[0] ??
    null;
  const resolvedDeepResearchModel: AiProviderModel | null = simpleMode.enabled
    ? findModel(
        simpleMode.webResearch,
        keys,
        simpleWebResearchModels,
        simpleMode.webResearch?.title,
      )
    : (validatedStoredDeepResearch ?? defaultDeepResearchModel);

  // selectedVirtualMcp — URL-derived
  const selectedVirtualMcpData = useVirtualMCP(urlVirtualMcpId);
  const selectedVirtualMcp: VirtualMCPInfo = selectedVirtualMcpData ?? {
    id: urlVirtualMcpId,
    title: "",
    description: null,
    icon: null,
  };

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

  const value: ChatPrefsContextValue = {
    selectedModel,
    setModel: (model: AiProviderModel) => {
      if (!model.keyId) return;
      setStoredChatRef({ keyId: model.keyId, modelId: model.modelId });
      setSessionCredentialId(null);
    },
    credentialId: effectiveKeyId,
    setCredentialId: setSessionCredentialId,
    allModelsConnections: keys,
    isModelsLoading,
    selectedVirtualMcp,
    imageModel: resolvedImageModel,
    setImageModel: (model: AiProviderModel | null) => {
      setStoredImageRef(
        model?.keyId ? { keyId: model.keyId, modelId: model.modelId } : null,
      );
    },
    deepResearchModel: resolvedDeepResearchModel,
    setDeepResearchModel: (model: AiProviderModel | null) => {
      setStoredDeepResearchRef(
        model?.keyId ? { keyId: model.keyId, modelId: model.modelId } : null,
      );
    },
    chatMode,
    setChatMode,
    appContexts,
    setAppContext,
    clearAppContext,
    tiptapDoc,
    setTiptapDoc,
    tiptapDocRef,
    resetInteraction: () => {},
    simpleModeEnabled: simpleMode.enabled,
    simpleModeTier: activeTier,
    setSimpleModeTier: setStoredTier,
  };

  return (
    <ChatPrefsCtx.Provider value={value}>{children}</ChatPrefsCtx.Provider>
  );
}

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
    virtualMcpId: urlVirtualMcpId,
    navigateToTask: rawNavigateToTask,
  } = useChatNavigation();

  // Preferences
  const [preferences] = usePreferences();
  const { markTaskRead } = useTaskReadState();

  // Model selection (localStorage-backed, identifier refs only — metadata
  // is re-resolved from the live models list every render to avoid staleness).
  const [storedChatRef, setStoredChatRef] = useLocalStorage<ModelRef | null>(
    LOCALSTORAGE_KEYS.chatSelectedModel(locator),
    null,
  );
  const [storedImageRef, setStoredImageRef] = useLocalStorage<ModelRef | null>(
    LOCALSTORAGE_KEYS.chatSelectedImageModel(locator),
    null,
  );
  const [storedDeepResearchRef, setStoredDeepResearchRef] =
    useLocalStorage<ModelRef | null>(
      LOCALSTORAGE_KEYS.chatSelectedDeepResearchModel(locator),
      null,
    );

  // Session-only credential override. Lets the picker browse models for a
  // different credential before the user commits via setModel. Resets on
  // reload — not persisted.
  const [sessionCredentialId, setSessionCredentialId] = useState<string | null>(
    null,
  );

  const [chatMode, setChatMode] = useState<ChatMode>("default");
  chatModeForTransportRef.current = chatMode;

  // Simple Model Mode — org-level config.
  const simpleMode = useSimpleMode();
  const [storedTier, setStoredTier] = useLocalStorage<SimpleTier | null>(
    LOCALSTORAGE_KEYS.chatSimpleModeTier(locator),
    null,
  );
  const activeTier = resolveActiveTier(storedTier, simpleMode);

  // AI provider keys and models.
  const keys = useAiProviderKeys();
  const effectiveKeyId =
    sessionCredentialId && keys.some((k) => k.id === sessionCredentialId)
      ? sessionCredentialId
      : storedChatRef && keys.some((k) => k.id === storedChatRef.keyId)
        ? storedChatRef.keyId
        : (keys[0]?.id ?? null);
  // Always fetch models — React Query (staleTime 60s) caches across consumers.
  const { models: allKeyModels, isLoading: isModelsQueryLoading } =
    useAiProviderModels(effectiveKeyId ?? undefined);
  const effectiveProviderId =
    keys.find((k) => k.id === effectiveKeyId)?.providerId ?? "anthropic";
  const defaultModel = selectDefaultModel(
    allKeyModels,
    effectiveProviderId,
    effectiveKeyId ?? undefined,
  );

  // Simple Mode slots can reference any credential, not just effectiveKeyId.
  // Fetch models for each slot's keyId directly so findModel returns real
  // AiProviderModel objects with full capabilities (file upload, etc).
  // Each useAiProviderModels call is a separate, cached React Query — no
  // duplicate requests when a keyId is reused across slots.
  const activeChatSlot = simpleMode.chat[activeTier];
  const { models: simpleChatModels } = useAiProviderModels(
    activeChatSlot?.keyId,
  );
  const { models: simpleImageModels } = useAiProviderModels(
    simpleMode.image?.keyId,
  );
  const { models: simpleWebResearchModels } = useAiProviderModels(
    simpleMode.webResearch?.keyId,
  );

  // Validate stored refs against the live models list. When validation fails
  // we fall through to defaults; the stale ref stays on disk harmlessly and
  // gets overwritten the next time the user picks a model. (We intentionally
  // do NOT write to localStorage during render.)
  const validatedStoredChat = findModel(storedChatRef, keys, allKeyModels);

  // Resolve the chat model: Simple Mode and regular paths are mutually
  // exclusive — no silent shadowing.
  const selectedModel: AiProviderModel | null = simpleMode.enabled
    ? findModel(activeChatSlot, keys, simpleChatModels, activeChatSlot?.title)
    : (validatedStoredChat ?? defaultModel);
  const isModelsLoading = !storedChatRef && isModelsQueryLoading;

  // Image model — same split.
  const imageModels = allKeyModels.filter((m) =>
    m.capabilities?.includes("image"),
  );
  const validatedStoredImage = findModel(storedImageRef, keys, imageModels);
  const resolvedImageModel: AiProviderModel | null = simpleMode.enabled
    ? findModel(
        simpleMode.image,
        keys,
        simpleImageModels,
        simpleMode.image?.title,
      )
    : (validatedStoredImage ?? imageModels[0] ?? null);

  // Deep research model — same split.
  const deepResearchModels = allKeyModels.filter((m) => {
    const n = m.modelId.toLowerCase().replace(/[^a-z0-9]/g, "");
    return n.includes("sonar") || n.includes("deepresearch");
  });
  const validatedStoredDeepResearch = findModel(
    storedDeepResearchRef,
    keys,
    deepResearchModels,
  );
  const defaultDeepResearchModel =
    deepResearchModels.find((m) => m.modelId === "perplexity/sonar") ??
    deepResearchModels[0] ??
    null;
  const resolvedDeepResearchModel: AiProviderModel | null = simpleMode.enabled
    ? findModel(
        simpleMode.webResearch,
        keys,
        simpleWebResearchModels,
        simpleMode.webResearch?.title,
      )
    : (validatedStoredDeepResearch ?? defaultDeepResearchModel);

  // Task management (scoped by URL virtualMcpId — task list doesn't change on override)
  const taskManager = useTaskManager(virtualMcpId);
  const { tasks } = taskManager;

  // taskId always comes from the URL (seeded by router's validateSearch)
  const effectiveTaskId = urlTaskId;

  // Effective agent: URL param ?? prop (thread owner)
  const effectiveVirtualMcpId = urlVirtualMcpId;

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
            toolApprovalLevel: readToolApprovalLevel(),
            // mode comes from mergedMetadata (set in sendMessageInternal before
            // the mode state is reset). Reading from a ref here races with the
            // React state flush that resets chatMode to "default".
          },
        };
      },
    });
  }

  // Bridge ref — ActiveTaskProvider registers sendMessage here
  const bridgeRef = useRef<ChatBridgeValue>(BRIDGE_NOOP);

  const navigateToTask = (
    taskId: string,
    opts?: { virtualMcpId?: string; autosend?: boolean },
  ) => {
    markTaskRead(taskId);
    rawNavigateToTask(taskId, {
      virtualMcpId: opts?.virtualMcpId,
      autosend: opts?.autosend,
    });
  };

  const activeTask = tasks.find((t) => t.id === effectiveTaskId);
  const currentBranch = activeTask?.branch ?? null;
  const isBranchLocked = !!activeTask?.branch;

  // Create task — calls COLLECTION_THREADS_CREATE up-front with the active
  // task's branch so the new thread lands on the same warm sandbox. The
  // route loader's useEnsureTask will see the row already exists on its
  // GET and skip the create-on-404 fallback.
  const taskActions = useTaskActions();
  const createTask = (): string => {
    const newId = crypto.randomUUID();
    void taskActions.create
      .mutateAsync({
        id: newId,
        virtual_mcp_id: virtualMcpId,
        ...(currentBranch ? { branch: currentBranch } : {}),
      } as Partial<Task>)
      .then(() => navigateToTask(newId))
      .catch(() => {
        // create error toast already fired by useCollectionActions; navigate
        // anyway so the user's not stranded — the route loader's ensure
        // fallback will retry.
        navigateToTask(newId);
      });
    return newId;
  };

  // Create task + hand off the message via URL ?autosend= so the new
  // task's ActiveTaskProvider fires it on mount. Propagates currentBranch
  // only when the new task is on the same vMCP (different vMCPs have their
  // own vmMap, so carrying a branch across them would land on a cold
  // sandbox).
  const createTaskWithMessage = (params: {
    message: SendMessageParams;
    virtualMcpId?: string;
  }) => {
    const newId = crypto.randomUUID();
    const targetVmcp = params.virtualMcpId ?? virtualMcpId;
    const carryBranch = targetVmcp === virtualMcpId ? currentBranch : null;
    writeStoredAutosend(sessionStorage, locator, newId, params.message);
    void taskActions.create
      .mutateAsync({
        id: newId,
        virtual_mcp_id: targetVmcp,
        ...(carryBranch ? { branch: carryBranch } : {}),
      } as Partial<Task>)
      .then(() =>
        navigateToTask(newId, {
          virtualMcpId: params.virtualMcpId,
          autosend: true,
        }),
      )
      .catch(() => {
        navigateToTask(newId, {
          virtualMcpId: params.virtualMcpId,
          autosend: true,
        });
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
    currentBranch,
    isBranchLocked,
    setCurrentTaskBranch: (branch: string | null) => {
      if (effectiveTaskId) {
        taskManager.setTaskBranch(effectiveTaskId, branch);
      }
    },
    ownerFilter: taskManager.ownerFilter,
    setOwnerFilter: taskManager.setOwnerFilter,
    isFilterChangePending: taskManager.isFilterChangePending ?? false,
  };

  const prefsValue: ChatPrefsContextValue = {
    selectedModel,
    setModel: (model: AiProviderModel) => {
      if (!model.keyId) return;
      setStoredChatRef({ keyId: model.keyId, modelId: model.modelId });
      // Clear session override — the new model's keyId is the new source of truth.
      setSessionCredentialId(null);
    },
    credentialId: effectiveKeyId,
    setCredentialId: setSessionCredentialId,
    allModelsConnections: keys,
    isModelsLoading,
    selectedVirtualMcp,
    imageModel: resolvedImageModel,
    setImageModel: (model: AiProviderModel | null) => {
      setStoredImageRef(
        model?.keyId ? { keyId: model.keyId, modelId: model.modelId } : null,
      );
    },
    deepResearchModel: resolvedDeepResearchModel,
    setDeepResearchModel: (model: AiProviderModel | null) => {
      setStoredDeepResearchRef(
        model?.keyId ? { keyId: model.keyId, modelId: model.modelId } : null,
      );
    },
    chatMode,
    setChatMode,
    appContexts,
    setAppContext,
    clearAppContext,
    tiptapDoc,
    setTiptapDoc,
    tiptapDocRef,
    resetInteraction: () => {},
    simpleModeEnabled: simpleMode.enabled,
    simpleModeTier: activeTier,
    setSimpleModeTier: setStoredTier,
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
        <ChatBridgeCtx.Provider value={bridgeRef}>
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
  const { virtualMcpId, tasks, currentBranch } = useChatTask();

  // Fire chat_opened once per (page session × taskId). Runs during render, but
  // the Set gate keeps it idempotent. Fires for every thread a user views —
  // new or existing — giving us a "chat session view" signal distinct from
  // chat_started (thread creation).
  if (taskId && !openedChats.has(taskId)) {
    openedChats.add(taskId);
    track("chat_opened", { thread_id: taskId });
  }
  const {
    selectedModel,
    imageModel,
    deepResearchModel,
    chatMode,
    setChatMode,
    appContexts,
    setTiptapDoc,
    setModel,
  } = useChatPrefs();
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

  const { org, locator } = useProjectContext();

  // Messages for current task (from React Query / server) — this is what suspends
  const serverMessages = useTaskMessages(taskId || null);

  const [finishReason, setFinishReason] = useState<string | null>(null);
  const [chatError, setChatError] = useState<Error | null>(null);

  const onToolCall = useInvalidateCollectionsOnToolCall();
  const queryClient = useQueryClient();

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

      // Refresh download chips for files share_with_user produced this turn.
      if (taskId) {
        queryClient.invalidateQueries({
          queryKey: KEYS.threadOutputs(taskId),
        });
      }

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
  useStreamManager(taskId, chat, thread?.status);

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
      ...(currentBranch ? { branch: currentBranch } : {}),
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

    let modeToSend: ChatMode = chatMode;
    if (modeToSend === "gen-image" && !imageModel) {
      modeToSend = "default";
    }
    if (modeToSend === "web-search" && !deepResearchModel) {
      modeToSend = "default";
    }
    // One-shot modes (web-search, gen-image) reset after send.
    // Plan mode is persistent — the user must explicitly disable it.
    if (modeToSend !== "plan") {
      setChatMode("default");
    }

    const metadata: Metadata = {
      ...messageMetadata,
      system,
      models: {
        credentialId: model.keyId ?? effectiveKeyId ?? "",
        thinking: toMetadataModelInfo(model),
        fast: toMetadataModelInfo(model),
        ...(imageModel && {
          image: toMetadataModelInfo(imageModel),
        }),
        ...(deepResearchModel && {
          deepResearch: toMetadataModelInfo(deepResearchModel),
        }),
      },
      mode: modeToSend,
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
  bridgeRef.current = {
    sendMessage: sendMessageInternal,
    isStreaming: chat.status === "submitted" || chat.status === "streaming",
  };

  // Autosend consumer: the URL carries only `autosend=true`; the message
  // body lives in sessionStorage keyed by locator + taskId. It only boots empty
  // threads, and the stored status gates duplicate sends across remounts.
  const autosendSearch = useSearch({ strict: false }) as { autosend?: string };
  const shouldAutosend = autosendSearch.autosend === AUTOSEND_QUERY_VALUE;
  // oxlint-disable-next-line ban-use-effect/ban-use-effect, react-hooks/exhaustive-deps -- storage status, not function identity, gates duplicate sends
  useEffect(() => {
    if (!shouldAutosend) return;
    if (messages.length > 0) return;

    const payload = claimStoredAutosend(sessionStorage, locator, taskId);
    if (!payload) return;

    void sendMessageInternal(payload.message).then(() => {
      clearStoredAutosend(sessionStorage, locator, taskId);
    });
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps -- storage status, not function identity, gates duplicate sends
  }, [shouldAutosend, messages.length, locator, taskId, sendMessageInternal]);

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

export function useOptionalChatPrefs(): ChatPrefsContextValue | null {
  return useContext(ChatPrefsCtx);
}

export function useOptionalChatTask(): ChatTaskContextValue | null {
  return useContext(ChatTaskCtx);
}

export function useChatBridge(): ChatBridgeValue {
  const ref = useContext(ChatBridgeCtx);
  // Return wrappers that read .current at call time. Destructuring
  // `{ sendMessage }` still sees the latest implementation even when the
  // ref is mutated after this hook call (which is the case when
  // ActiveTaskProvider registers sendMessage after the consumer mounts).
  return {
    sendMessage: (params) => ref.current.sendMessage(params),
    get isStreaming() {
      return ref.current.isStreaming;
    },
  };
}

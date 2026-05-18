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
import type { UseChatHelpers } from "@ai-sdk/react";
import {
  AUTOSEND_QUERY_VALUE,
  claimStoredAutosend,
  clearStoredAutosend,
  writeStoredAutosend,
} from "@/web/lib/autosend";
import { useThreadChat } from "./hooks/use-thread-chat";
import type { RequestOptions } from "./hooks/thread-attach-registry";
import {
  pickSimpleModeDefaults,
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

import { useChatNavigation } from "./hooks/use-chat-navigation";
import { useStreamManager } from "./hooks/use-stream-manager";
import {
  useThreadActions,
  useTaskManager,
  type RowPatch,
  type TaskOwnerFilter,
} from "./task";
import { useTaskMessages } from "./task/use-task-manager";
import { derivePartsFromTiptapDoc } from "./derive-parts";
import type { VirtualMCPInfo } from "./select-virtual-mcp";
import type { ChatMessage, ChatMode, Metadata } from "./types";
import type { Task } from "./task/types";
import type { SendMessageParams, SetAppContextParams } from "./store/types";
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
  addToolOutput: (
    args: {
      toolCallId: string;
      output?: unknown;
      state?: "output-available" | "output-error";
      errorText?: string;
    },
    opts: RequestOptions,
  ) => void;
  addToolApprovalResponse: (
    args: { id: string; approved: boolean; reason?: string },
    opts: RequestOptions,
  ) => void;
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
  /** The currently selected tier in Simple Model Mode */
  simpleModeTier: SimpleTier;
  setSimpleModeTier: (tier: SimpleTier) => void;
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
 * Pick the active chat tier from the user's stored choice, defaulting to
 * "smart". All three chat tiers are always selectable — the backend's
 * resolveTier() falls back to SDK provider defaults when the org's tier
 * slot is unset, so we don't need to gate on slot configuration here.
 */
function resolveActiveTier(stored: SimpleTier | null): SimpleTier {
  if (stored === "fast" || stored === "smart" || stored === "thinking") {
    return stored;
  }
  return "smart";
}

/**
 * Mirror backend resolveTier() when no slot is explicitly assigned: pick a
 * tier-appropriate default from the effective key's catalog so the UI can
 * read capabilities (file upload, vision, etc.) instead of falling back to
 * a null model. Backend pickSimpleModeDefaults considers all keys; we only
 * have the effective key's catalog client-side, so multi-key orgs may see a
 * single-key-derived default. This matches the backend's pick when the
 * effective key is also the first match for the tier.
 */
function pickFallbackChatModel(
  tier: SimpleTier,
  keys: AiProviderKey[],
  effectiveKeyId: string | null,
  models: AiProviderModel[],
): AiProviderModel | null {
  if (!effectiveKeyId || models.length === 0) return null;
  const key = keys.find((k) => k.id === effectiveKeyId);
  if (!key) return null;
  const defaults = pickSimpleModeDefaults([key], {
    [effectiveKeyId]: models,
  });
  const slot =
    tier === "fast"
      ? defaults.chat.fast
      : tier === "thinking"
        ? defaults.chat.thinking
        : defaults.chat.smart;
  if (!slot) return null;
  const full = models.find((m) => m.modelId === slot.modelId);
  if (!full) return null;
  return { ...full, keyId: effectiveKeyId };
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
  user: { image?: string | null; name?: string } | null;
  contextPrompt: string;
  preferences: {
    toolApprovalLevel?: import("../../hooks/use-preferences").ToolApprovalLevel;
  };
  taskManager: {
    updateMessagesCache: (taskId: string, messages: ChatMessage[]) => void;
    patchTask: (patch: RowPatch) => void;
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

  // Model selection (localStorage-backed) — image and deep research only;
  // chat model is always tier-driven.
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
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  chatModeForTransportRef.current = chatMode;

  // Simple Model Mode
  const simpleMode = useSimpleMode();
  const [storedTier, setStoredTier] = useLocalStorage<SimpleTier | null>(
    LOCALSTORAGE_KEYS.chatSimpleModeTier(locator),
    null,
  );
  const activeTier = resolveActiveTier(storedTier);

  // AI provider keys + models
  const keys = useAiProviderKeys();
  const activeChatSlot = simpleMode.tiers[activeTier];
  const effectiveKeyId =
    sessionCredentialId && keys.some((k) => k.id === sessionCredentialId)
      ? sessionCredentialId
      : (activeChatSlot?.keyId ?? keys[0]?.id ?? null);
  const { models: allKeyModels, isLoading: isModelsQueryLoading } =
    useAiProviderModels(effectiveKeyId ?? undefined);

  const { models: simpleChatModels } = useAiProviderModels(
    activeChatSlot?.keyId,
  );
  const { models: simpleImageModels } = useAiProviderModels(
    simpleMode.tiers.image?.keyId,
  );
  const { models: simpleWebResearchModels } = useAiProviderModels(
    simpleMode.tiers.web_research?.keyId,
  );

  const selectedModel: AiProviderModel | null =
    findModel(activeChatSlot, keys, simpleChatModels, activeChatSlot?.title) ??
    pickFallbackChatModel(activeTier, keys, effectiveKeyId, allKeyModels);
  const isModelsLoading = isModelsQueryLoading;

  const imageModels = allKeyModels.filter((m) =>
    m.capabilities?.includes("image"),
  );
  const validatedStoredImage = findModel(storedImageRef, keys, imageModels);
  const resolvedImageModel: AiProviderModel | null =
    findModel(
      simpleMode.tiers.image,
      keys,
      simpleImageModels,
      simpleMode.tiers.image?.title,
    ) ??
    validatedStoredImage ??
    imageModels[0] ??
    null;

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
  const resolvedDeepResearchModel: AiProviderModel | null =
    findModel(
      simpleMode.tiers.web_research,
      keys,
      simpleWebResearchModels,
      simpleMode.tiers.web_research?.title,
    ) ??
    validatedStoredDeepResearch ??
    defaultDeepResearchModel;

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
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  tiptapDocRef.current = tiptapDoc;

  const value: ChatPrefsContextValue = {
    selectedModel,
    setModel: () => {},
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
    simpleModeTier: activeTier,
    setSimpleModeTier: (tier: SimpleTier) => setStoredTier(tier),
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
  const { locator } = useProjectContext();
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

  // Model selection (localStorage-backed) — image and deep research only;
  // chat model is always tier-driven.
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
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  chatModeForTransportRef.current = chatMode;

  // Simple Model Mode — org-level config.
  const simpleMode = useSimpleMode();
  const [storedTier, setStoredTier] = useLocalStorage<SimpleTier | null>(
    LOCALSTORAGE_KEYS.chatSimpleModeTier(locator),
    null,
  );
  const activeTier = resolveActiveTier(storedTier);

  // AI provider keys and models.
  const keys = useAiProviderKeys();
  // Simple Mode slots can reference any credential, not just effectiveKeyId.
  // Fetch models for each slot's keyId directly so findModel returns real
  // AiProviderModel objects with full capabilities (file upload, etc).
  // Each useAiProviderModels call is a separate, cached React Query — no
  // duplicate requests when a keyId is reused across slots.
  const activeChatSlot = simpleMode.tiers[activeTier];
  const effectiveKeyId =
    sessionCredentialId && keys.some((k) => k.id === sessionCredentialId)
      ? sessionCredentialId
      : (activeChatSlot?.keyId ?? keys[0]?.id ?? null);
  // Always fetch models — React Query (staleTime 60s) caches across consumers.
  const { models: allKeyModels, isLoading: isModelsQueryLoading } =
    useAiProviderModels(effectiveKeyId ?? undefined);

  const { models: simpleChatModels } = useAiProviderModels(
    activeChatSlot?.keyId,
  );
  const { models: simpleImageModels } = useAiProviderModels(
    simpleMode.tiers.image?.keyId,
  );
  const { models: simpleWebResearchModels } = useAiProviderModels(
    simpleMode.tiers.web_research?.keyId,
  );

  // Resolve the chat model from the active tier slot, falling back to a
  // tier-aware pick from the effective key's catalog when no slot is set —
  // mirrors backend resolveTier so capabilities (file upload, vision) are
  // accurate without waiting for the first stream response.
  const selectedModel: AiProviderModel | null =
    findModel(activeChatSlot, keys, simpleChatModels, activeChatSlot?.title) ??
    pickFallbackChatModel(activeTier, keys, effectiveKeyId, allKeyModels);
  const isModelsLoading = isModelsQueryLoading;

  // Image model — tier-driven, fall back to stored/defaults.
  const imageModels = allKeyModels.filter((m) =>
    m.capabilities?.includes("image"),
  );
  const validatedStoredImage = findModel(storedImageRef, keys, imageModels);
  const resolvedImageModel: AiProviderModel | null =
    findModel(
      simpleMode.tiers.image,
      keys,
      simpleImageModels,
      simpleMode.tiers.image?.title,
    ) ??
    validatedStoredImage ??
    imageModels[0] ??
    null;

  // Deep research model — tier-driven, fall back to stored/defaults.
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
  const resolvedDeepResearchModel: AiProviderModel | null =
    findModel(
      simpleMode.tiers.web_research,
      keys,
      simpleWebResearchModels,
      simpleMode.tiers.web_research?.title,
    ) ??
    validatedStoredDeepResearch ??
    defaultDeepResearchModel;

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
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  tiptapDocRef.current = tiptapDoc;

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
  const taskActions = useThreadActions();
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
    setModel: () => {},
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
    simpleModeTier: activeTier,
    setSimpleModeTier: (tier: SimpleTier) => setStoredTier(tier),
  };

  const internals: TaskProviderInternals = {
    user,
    contextPrompt,
    preferences,
    taskManager: {
      updateMessagesCache: taskManager.updateMessagesCache,
      patchTask: taskManager.patchTask,
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
    imageModel,
    deepResearchModel,
    chatMode,
    setChatMode,
    appContexts,
    setTiptapDoc,
    simpleModeTier: activeTier,
  } = useChatPrefs();
  const internals = useContext(TaskInternalsCtx);
  if (!internals) {
    throw new Error(
      "ActiveTaskProvider must be used within ChatContextProvider",
    );
  }

  const {
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

  // Subscribe model: persistent /stream + POST /messages. No useChat.
  const chat = useThreadChat<ChatMessage>({
    threadId: taskId,
    orgSlug: org.slug,
    initialMessages: serverMessages,
    onFinish: (payload) => {
      setFinishReason(payload.finishReason ?? null);

      // Refresh download chips only when this turn actually produced a
      // shared file. AI SDK v5 surfaces tool invocations as `tool-<name>`
      // parts; filter on `output-available` to skip denied/cancelled calls.
      // (Cast: VM tools — including share_with_user — are added to the
      // built-in tool set at runtime but aren't reflected in the
      // BuiltInToolSet return-type cast, so the part union lacks this
      // member at compile time.)
      const sharedFile = payload.message.parts?.some((p) => {
        const part = p as { type: string; state?: string };
        return (
          part.type === "tool-share_with_user" &&
          part.state === "output-available"
        );
      });
      if (taskId && sharedFile) {
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

      // Note: in the subscribe model the persistent /stream delivers
      // assistant chunks to every observer on the thread, so onFinish
      // fires on each tab — including passive ones whose local snapshot
      // doesn't include the originating user message. Writing
      // payload.messages straight to the cache from here would clobber
      // the sender's full conversation with the passive tab's partial
      // one. Skip the direct cache update and let
      // useStreamManager.onFinish invalidate THREAD_MESSAGES instead —
      // every tab refetches the authoritative server snapshot.
    },
    onToolCall: onToolCall as never,
    onError: (error: Error) => {
      setChatError(error);
      console.error("[chat] Error", error);
    },
    onData: (chunk) => {
      if (chunk.type === "data-thread-title") {
        const { title } = (chunk as { data: { title?: string } }).data;
        if (!title) return;
        // Server has already persisted the title (see dispatch-run.ts) —
        // patch the cache directly instead of issuing a redundant
        // COLLECTION_THREADS_UPDATE round-trip via renameTask.
        taskManager.patchTask({
          id: taskId,
          title,
          updated_at: new Date().toISOString(),
        });
      }
    },
  });

  // Derived state. useThreadChat already composes server + optimistic +
  // streaming messages internally — chat.messages is the live view.
  const isStreaming =
    chat.status === "submitted" || chat.status === "streaming";
  const messages = chat.messages;
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

  // Watch-SSE driven cache invalidations for this thread. The subscribe
  // stream is always open in useThreadChat — resume / reconnect logic
  // lives there, not here.
  useStreamManager(taskId);

  // sendMessage — captures context at call time
  async function sendMessageInternal(params: SendMessageParams): Promise<void> {
    const parts = params.parts ?? derivePartsFromTiptapDoc(params.tiptapDoc);
    if (parts.length === 0) return;

    // Capture at send time (frozen in closure)
    const capturedTaskId = taskId;
    const capturedVirtualMcpId = virtualMcpId;

    setFinishReason(null);
    // Drop any error banner from a prior turn — explicitly sending a new
    // message means the user has moved on and a stale "network error"
    // toast on top of a fresh request is just noise.
    setChatError(null);
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
    // Plan and gen-image modes are sticky — the user explicitly toggles them
    // off. Web-search is one-shot (resets after each send).
    if (modeToSend === "web-search") {
      setChatMode("default");
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts,
      metadata: messageMetadata,
    };

    await chat.sendMessage(userMessage, {
      tier: activeTier,
      mode: modeToSend,
      toolApprovalLevel:
        preferences.toolApprovalLevel ?? readToolApprovalLevel(),
      system: system || undefined,
      agent: { id: capturedVirtualMcpId },
      thread_id: capturedTaskId,
      branch: currentBranch,
    });
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
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
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

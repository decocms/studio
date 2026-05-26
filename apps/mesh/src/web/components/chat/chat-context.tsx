/**
 * Chat Provider — split architecture with Suspense boundary support.
 *
 * TaskProvider (outer)
 *   Contexts: ChatTaskContext, ChatPrefsContext
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
  use,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  AUTOSEND_QUERY_VALUE,
  claimStoredAutosend,
  clearStoredAutosend,
  writeStoredAutosend,
} from "@/web/lib/autosend";
import {
  getOrOpenStream,
  type ConnStatus,
  type RequestOptions,
  type Store,
  type SubmitAction,
  type ThreadObserver,
} from "./store/thread-connection";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import type { HarnessId } from "@/harnesses";
import { AGENT_OPTION_PINS, type AgentOption } from "./pills/agent-options";
import {
  isStudioPackAgent,
  pickSimpleModeDefaults,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
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

/** Subscribe a React component to a connection Store via useSyncExternalStore. */
function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Map the conn's discriminated `ConnStatus` onto the public string status.
 *  "loading" is collapsed to "ready" — bootstrap is short and the UI treats
 *  pre-snapshot the same as ready-but-empty. */
function statusToString(s: ConnStatus): ChatStreamContextValue["status"] {
  if (s.kind === "loading") return "ready";
  return s.kind;
}

import { useChatNavigation } from "./hooks/use-chat-navigation";
import { useThreadActions, useThreadManager } from "./store/hooks";
import { derivePartsFromTiptapDoc } from "./derive-parts";
import type { VirtualMCPInfo } from "./select-virtual-mcp";
import type { ChatMessage, ChatMode, Metadata } from "./types";
import type { Task } from "./task/types";
import type { SendMessageParams, SetAppContextParams } from "./store/types";
import { useLocalStorage } from "../../hooks/use-local-storage";
import { chatModeForTransportRef } from "../../lib/chat-mode-sync";
import { agentHasClonableSource } from "@/web/lib/agent-capabilities";
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
  /** Single mutator entry point — new user message, tool output, or approval
   *  response. Patches local messages, clears finishReason, POSTs to /messages.
   *  Throws if a toolOutput / approval target isn't found in current messages. */
  submit: (action: SubmitAction, opts: RequestOptions) => Promise<void>;
  error: Error | null;
  clearError: () => void;
  finishReason: string | null;
  clearFinishReason: () => void;
  isStreaming: boolean;
  isChatEmpty: boolean;
  isWaitingForApprovals: boolean;
  isRunInProgress: boolean;
  hasMoreOlder: boolean;
  isFetchingOlder: boolean;
  fetchOlderMessages: () => Promise<void>;
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
  activeTask: Task | null;
  /** thread.branch — the only source of truth. Null until the user picks one or the server generates one on first send. */
  currentBranch: string | null;
  /**
   * Immutable once set: switching branches mid-conversation would reroute the
   * thread's sandboxMap entry, so users must create a new thread for another branch.
   */
  isBranchLocked: boolean;
  /** Persist pinned branch onto the thread (cache + server). */
  setCurrentTaskBranch: (branch: string | null) => void;
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
  /**
   * The agent option the chat will use for the next first message
   * (`Decopilot` / `Decopilot desktop` / `Claude Code desktop` /
   * `Codex desktop`). Single source of truth for the (harness, sandbox)
   * pair — see `AGENT_OPTION_PINS` in `./pills/agent-options`.
   *
   * This is the **effective** value: the user's persisted pick filtered
   * through what the active agent can actually run. If the user picked a
   * desktop variant but the current agent has no clonable source
   * (Decopilot-only / ephemeral), this falls back to plain Decopilot.
   * The persisted pick is unchanged and returns when navigating back to
   * an agent with a checkout. The setter writes to the raw underlying state.
   *
   * Null = server picks the default. Persisted to localStorage so the
   * choice survives page reloads.
   */
  pendingAgentOption: AgentOption | null;
  setPendingAgentOption: (option: AgentOption | null) => void;
  /** Derived from `pendingAgentOption`. Read-only. */
  pendingHarnessId: HarnessId | null;
  /** Derived from `pendingAgentOption`. Read-only. */
  pendingSandboxProviderKind: SandboxProviderKind | null;
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

/** Internal-only type for cross-provider communication */
interface TaskProviderInternals {
  user: { image?: string | null; name?: string } | null;
  contextPrompt: string;
  preferences: {
    toolApprovalLevel?: import("../../hooks/use-preferences").ToolApprovalLevel;
  };
  rawNavigateToTask: (taskId: string) => void;
}

// ============================================================================
// Contexts
// ============================================================================

const ChatStreamCtx = createContext<ChatStreamContextValue | null>(null);
const ChatTaskCtx = createContext<ChatTaskContextValue | null>(null);
const ChatPrefsCtx = createContext<ChatPrefsContextValue | null>(null);

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
 * `ChatContextProvider` composes this provider, so routes that mount the
 * full chat context get the prefs context via the same code path. If a
 * parent layout has already mounted `ChatPrefsProvider`, the inner mount
 * shadows it — persistent state still syncs via localStorage; transient
 * state (chatMode, tiptapDoc, appContexts) is scoped to whichever mount
 * the consumer reads from.
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

  // Pending agent — single source of truth for the user's pre-message
  // pick (`Decopilot` / `Decopilot desktop` / `Claude Code desktop` /
  // `Codex desktop`). Persisted to localStorage so the choice survives
  // page reloads.
  //
  // Everything else (`pendingHarnessId`, `pendingSandboxProviderKind`,
  // the request body's harnessId/sandboxProviderKind) derives from this
  // through `AGENT_OPTION_PINS`, so the pill display and the submit can
  // never disagree.
  const [pendingAgentOption, setPendingAgentOptionState] =
    useState<AgentOption | null>(() => {
      try {
        const stored = localStorage.getItem(
          "chat:lastAgentOption",
        ) as AgentOption | null;
        return stored && stored in AGENT_OPTION_PINS ? stored : null;
      } catch {
        return null;
      }
    });
  const setPendingAgentOption = (option: AgentOption | null) => {
    setPendingAgentOptionState(option);
    try {
      if (option === null) {
        localStorage.removeItem("chat:lastAgentOption");
      } else {
        localStorage.setItem("chat:lastAgentOption", option);
      }
    } catch {
      // ignore storage errors (private browsing, quota exceeded, etc.)
    }
  };

  // Effective option: the user's pick filtered through what the current
  // agent can actually run. Desktop-CLI options (Claude Code / Codex /
  // Decopilot desktop) need a git branch to check out on the user's
  // desktop; if the user picked a desktop variant but the current agent
  // has no clonable source (Decopilot-only / ephemeral), this falls back
  // to plain Decopilot. The persisted pick is unchanged and returns when
  // navigating back to an agent with a checkout.
  const hasClonableSource = agentHasClonableSource(
    selectedVirtualMcpData?.metadata,
  );
  const effectiveAgentOption: AgentOption | null =
    pendingAgentOption === null
      ? null
      : !hasClonableSource &&
          AGENT_OPTION_PINS[pendingAgentOption].sandbox === "user-desktop"
        ? "decopilot"
        : pendingAgentOption;

  const effectivePins = effectiveAgentOption
    ? AGENT_OPTION_PINS[effectiveAgentOption]
    : null;
  const pendingHarnessId = effectivePins?.harness ?? null;
  const pendingSandboxProviderKind = effectivePins?.sandbox ?? null;

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
    pendingAgentOption: effectiveAgentOption,
    setPendingAgentOption,
    pendingHarnessId,
    pendingSandboxProviderKind,
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
  task,
  children,
}: PropsWithChildren<{ virtualMcpId: string; task: Task | null }>) {
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

  const threadActions = useThreadActions();

  // taskId always comes from the URL (seeded by router's validateSearch)
  const effectiveTaskId = urlTaskId;

  // Effective agent: URL param ?? prop (thread owner)
  const effectiveVirtualMcpId = urlVirtualMcpId;

  // Context prompt (uses effective agent)
  const contextPrompt = useContextHook(effectiveVirtualMcpId);

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

  // The active task row is resolved by the route layout via `useEnsureTask`
  // and threaded in as a prop, so this provider doesn't need to read the
  // panel-visible threads slot. Guard against transient prop/URL skew during
  // navigation by only honoring the prop when ids match.
  const activeTask =
    effectiveTaskId && task?.id === effectiveTaskId ? task : null;
  const currentBranch = activeTask?.branch ?? null;
  const isBranchLocked = !!activeTask?.branch;

  // Create task — calls COLLECTION_THREADS_CREATE up-front with the active
  // task's branch so the new thread lands on the same warm sandbox. The
  // route loader's useEnsureTask will see the row already exists on its
  // GET and skip the create-on-404 fallback.
  const createTask = (): string => {
    const newId = crypto.randomUUID();
    void threadActions
      .create({
        id: newId,
        virtual_mcp_id: virtualMcpId,
        ...(currentBranch ? { branch: currentBranch } : {}),
      })
      .then(() => navigateToTask(newId))
      .catch(() => {
        // Error toast surfaced by ThreadManagerStore.create; navigate anyway
        // so the user's not stranded — the route loader's ensure fallback
        // will retry.
        navigateToTask(newId);
      });
    return newId;
  };

  // Create task + hand off the message via URL ?autosend= so the new
  // task's ActiveTaskProvider fires it on mount. Propagates currentBranch
  // only when the new task is on the same vMCP (different vMCPs have their
  // own sandboxMap, so carrying a branch across them would land on a cold
  // sandbox).
  const createTaskWithMessage = (params: {
    message: SendMessageParams;
    virtualMcpId?: string;
  }) => {
    const newId = crypto.randomUUID();
    const targetVmcp = params.virtualMcpId ?? virtualMcpId;
    const carryBranch = targetVmcp === virtualMcpId ? currentBranch : null;
    writeStoredAutosend(sessionStorage, locator, newId, params.message);
    void threadActions
      .create({
        id: newId,
        virtual_mcp_id: targetVmcp,
        ...(carryBranch ? { branch: carryBranch } : {}),
      })
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

  // ---- Build context values ----

  const taskValue: ChatTaskContextValue = {
    virtualMcpId: effectiveVirtualMcpId,
    taskId: effectiveTaskId,
    openTask: navigateToTask,
    createTask,
    createTaskWithMessage,
    activeTask,
    currentBranch,
    isBranchLocked,
    setCurrentTaskBranch: (branch: string | null) => {
      if (effectiveTaskId) {
        threadActions.setBranch(effectiveTaskId, branch);
      }
    },
  };

  const internals: TaskProviderInternals = {
    user,
    contextPrompt,
    preferences,
    rawNavigateToTask,
  };

  return (
    <ChatTaskCtx.Provider value={taskValue}>
      <ChatPrefsProvider>
        <TaskInternalsCtx.Provider value={internals}>
          {children}
        </TaskInternalsCtx.Provider>
      </ChatPrefsProvider>
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
  const { virtualMcpId, activeTask, currentBranch } = useChatTask();

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
    pendingSandboxProviderKind,
    pendingHarnessId,
  } = useChatPrefs();
  const internals = useContext(TaskInternalsCtx);
  if (!internals) {
    throw new Error(
      "ActiveTaskProvider must be used within ChatContextProvider",
    );
  }

  const { user, contextPrompt, preferences, rawNavigateToTask } = internals;

  const { org, locator } = useProjectContext();

  const [chatError, setChatError] = useState<Error | null>(null);

  const onToolCall = useInvalidateCollectionsOnToolCall();
  const queryClient = useQueryClient();
  const manager = useThreadManager();
  const navigate = useNavigate();

  // The connection owns SSE subscription, POSTs, and message state. The
  // provider is keyed by taskId at the layout level, so this resolves to a
  // fresh conn per thread mount.
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const conn = getOrOpenStream(org.slug, taskId, { client });
  // Suspend until the initial-page MCP fetch settles. The Suspense boundary
  // in side-panel-chat.tsx (`<Suspense fallback={<Chat.Skeleton />}>`)
  // catches this and shows the skeleton instead of an empty message list.
  // `conn.ready` resolves on success, error, and null-client paths so the
  // chat unsuspends in every terminal case; error states are surfaced via
  // `status` and rendered inline.
  use(conn.ready);
  const messages = useStore(conn.messages) as ChatMessage[];
  const connStatus = useStore(conn.status);
  const finishReason = useStore(conn.finishReason);
  const hasMoreOlder = useStore(conn.hasMoreOlder);
  const isFetchingOlder = useStore(conn.isFetchingOlder);

  // Stable callback ref so the observer wrapper sees the latest consumer
  // callbacks without re-running the effect on every render.
  const cbRef = useRef({
    onToolCall,
    queryClient,
    rawNavigateToTask,
    taskId,
    manager,
    navigate,
  });
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  cbRef.current = {
    onToolCall,
    queryClient,
    rawNavigateToTask,
    taskId,
    manager,
    navigate,
  };

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- observer slot is per-mount; useEffect is the natural fit
  useEffect(() => {
    const observer: ThreadObserver = {
      // Auto-titler emits `data-thread-title` chunks as the turn streams. Mirror
      // the new title into the manager's thread row so the tasks panel updates
      // — no `/events` thread.title event exists; this is the only path.
      onData: (chunk) => {
        if (chunk.type === "data-thread-title") {
          const data = (chunk as unknown as { data: { title?: string } }).data;
          if (!data?.title) return;
          const cb = cbRef.current;
          if (!cb.taskId) return;
          cb.manager.patchThread({
            id: cb.taskId,
            title: data.title,
            updated_at: new Date().toISOString(),
          });
          return;
        }
        // Auto-open the preview panel on every published HTML page. Latest
        // slug always wins — matches the model's current focus.
        if (chunk.type === "data-html-page-published") {
          const data = (chunk as unknown as { data: { slug?: string } }).data;
          if (!data?.slug) return;
          const slug = data.slug;
          cbRef.current.navigate({
            to: ".",
            search: (prev: Record<string, unknown>) => ({
              ...prev,
              main: `web-page:${slug}`,
            }),
            replace: true,
          });
          return;
        }
      },
      onFinish: (message) => {
        const cb = cbRef.current;
        // Refresh download chips only when this turn actually produced a
        // shared file. AI SDK v5 surfaces tool invocations as `tool-<name>`
        // parts; filter on `output-available` to skip denied/cancelled calls.
        const sharedFile = message.parts?.some((p) => {
          const part = p as { type: string; state?: string };
          return (
            part.type === "tool-share_with_user" &&
            part.state === "output-available"
          );
        });
        if (cb.taskId && sharedFile) {
          cb.queryClient.invalidateQueries({
            queryKey: KEYS.threadOutputs(cb.taskId),
          });
        }

        // The "what's next for this agent" hint is derived server-side from
        // org state (brand exists? has pages? connections healthy?). Any turn
        // can flip that state, so re-fetch on every finish — covers both
        // `mine=true` and `mine=false` variants via partial-key match.
        cb.queryClient.invalidateQueries({
          queryKey: ["suggested-actions", org.slug],
        });
        cb.queryClient.invalidateQueries({
          queryKey: KEYS.studioPackChecklists(org.slug),
        });

        const serverThreadId = (message.metadata as Metadata | undefined)
          ?.thread_id;
        if (serverThreadId && serverThreadId !== cb.taskId) {
          cb.rawNavigateToTask(serverThreadId);
        }
      },
      onError: (error) => {
        setChatError(error);
        console.error("[chat] Error", error);
      },
      onToolCall: (event) => cbRef.current.onToolCall(event as never),
    };
    conn.observer = observer;
    return () => {
      if (conn.observer === observer) conn.observer = null;
    };
  }, [conn]);

  // Derived state.
  const isStreaming =
    connStatus.kind === "submitted" || connStatus.kind === "streaming";
  const isChatEmpty = messages.length === 0;
  const lastMessage = messages.at(-1);
  const isWaitingForApprovals =
    !isStreaming &&
    lastMessage?.role === "assistant" &&
    lastMessage.parts.some(
      (part) => "state" in part && part.state === "approval-requested",
    );
  const thread = activeTask;
  const isRunInProgress =
    (thread?.status === "in_progress" || thread?.status === "expired") &&
    connStatus.kind === "ready" &&
    messages.length > 0;

  // sendMessage — captures context at call time
  async function sendMessageInternal(params: SendMessageParams): Promise<void> {
    const parts = params.parts ?? derivePartsFromTiptapDoc(params.tiptapDoc);
    if (parts.length === 0) return;

    // Capture at send time (frozen in closure)
    const capturedTaskId = taskId;
    const capturedVirtualMcpId = virtualMcpId;

    // Drop any error banner from a prior turn — explicitly sending a new
    // message means the user has moved on and a stale "network error"
    // toast on top of a fresh request is just noise. (finishReason is
    // cleared inside conn.submit synchronously.)
    setChatError(null);
    setTiptapDoc(undefined);

    const messageMetadata: Metadata = {
      tiptapDoc: params.tiptapDoc,
      created_at: new Date().toISOString(),
      user: {
        avatar: user?.image ?? undefined,
        name: user?.name ?? "you",
      },
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

    await conn.submit(
      { kind: "message", message: userMessage },
      {
        tier: activeTier,
        mode: modeToSend,
        toolApprovalLevel:
          preferences.toolApprovalLevel ?? readToolApprovalLevel(),
        system: system || undefined,
        agent: { id: capturedVirtualMcpId },
        thread_id: capturedTaskId,
        branch: currentBranch,
        sandboxProviderKind: pendingSandboxProviderKind || undefined,
        harnessId: pendingHarnessId || undefined,
      },
    );
  }

  // Cancel run
  const cancelRun = async () => {
    conn.stop();
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

  // Studio Pack welcome materializer: when landing on a fresh
  // `thrd_welcome_<agentId>` thread with no autosend queued, ask the server
  // to insert the agent's state-aware welcome (text greeting or user_ask)
  // and merge it into the local message stream. The route is idempotent;
  // any later remount that finds messages already present is a no-op.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- one-shot fetch gated by empty messages + no autosend
  useEffect(() => {
    if (shouldAutosend) return;
    if (messages.length > 0) return;
    if (!virtualMcpId) return;
    if (!isStudioPackAgent(virtualMcpId)) return;
    if (taskId !== `thrd_welcome_${virtualMcpId}`) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/${org.slug}/studio-pack-welcome/${encodeURIComponent(
            virtualMcpId,
          )}/${encodeURIComponent(taskId)}`,
          { method: "POST", credentials: "include" },
        );
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as {
          inserted: boolean;
          message: ChatMessage | null;
        };
        if (!data.inserted || !data.message) return;
        conn.messages.update((curr) =>
          curr.some((m) => m.id === data.message?.id)
            ? curr
            : [...curr, data.message as ChatMessage],
        );
      } catch (err) {
        console.warn("[chat] studio-pack-welcome failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shouldAutosend, messages.length, virtualMcpId, taskId, org.slug, conn]);

  const streamValue: ChatStreamContextValue = {
    messages,
    status: statusToString(connStatus),
    sendMessage: sendMessagePublic,
    stop: () => void cancelRun(),
    submit: (action, opts) => conn.submit(action, opts),
    error: chatError,
    clearError: () => setChatError(null),
    finishReason,
    clearFinishReason: () => conn.finishReason.set(null),
    isStreaming,
    isChatEmpty,
    isWaitingForApprovals: isWaitingForApprovals ?? false,
    isRunInProgress,
    hasMoreOlder,
    isFetchingOlder,
    fetchOlderMessages: conn.fetchOlderMessages.bind(conn),
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

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
 * the active Chat side-panel view. Switching tasks shows a skeleton while keeping the
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
} from "@/lib/autosend";
import {
  getOrOpenStream,
  type ConnStatus,
  type RequestOptions,
  type Store,
  type SubmitAction,
  type ThreadObserver,
} from "./store/thread-connection";
import { deriveTerminalThreadStatus } from "./store/thread-status";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import type { HarnessId } from "@decocms/harness/types";
import {
  AGENT_OPTION_PINS,
  agentOptionFor,
  resolveOfflineAgentOption,
  type AgentOption,
} from "./pills/agent-options";
import { useCurrentLink } from "@/hooks/use-current-link";
import { resolveSubmitSettings } from "./resolve-submit-settings";
import {
  isDeepResearchModel,
  isQuickSearchModel,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  useVirtualMCP,
} from "@/sdk";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t";

import {
  useAiProviderKeys,
  useAiProviderModels,
  type AiProviderModel,
} from "../../hooks/collections/use-ai-providers";
import { useContext as useContextHook } from "../../hooks/use-context";
import {
  usePreferences,
  readToolApprovalLevel,
} from "../../hooks/use-preferences";
import { useInvalidateCollectionsOnToolCall } from "../../hooks/use-invalidate-collections-on-tool-call";
import { useDecopilotEvents } from "../../hooks/use-decopilot-events";
import { useTaskReadState } from "../../hooks/use-task-read-state";
import { authClient } from "../../lib/auth-client";
import { track } from "../../lib/posthog-client";

// Module-level set so a given chat fires `chat_opened` at most once per page
// session per thread_id. Prevents duplicates from re-renders while still
// re-firing when the user switches tasks.
const openedChats = new Set<string>();

/** Threads with a sendMessage currently in flight — a synchronous latch so a
 * rapid double-Enter can't double-submit/double-queue the same draft (the
 * composer intentionally never disables; state-based guards re-render too
 * late to stop the second keypress). */
const sendInFlight = new Set<string>();

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
import {
  derivePartsFromTiptapDoc,
  extractMentionedAgentId,
} from "./derive-parts";
import type { VirtualMCPInfo } from "./select-virtual-mcp";
import type { ChatMessage, ChatMode, Metadata } from "./types";
import type { Task } from "./task/types";
import type { SendMessageParams, SetAppContextParams } from "./store/types";
import type { RunStatusStage } from "./run-status";
import { useLocalStorage } from "../../hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "../../lib/localstorage-keys";
import { KEYS } from "../../lib/query-keys";
import {
  clearQueueDirty,
  dropPendingBody,
  enqueueMessage,
  isQueueDirty,
  markQueueDirty,
  messageQueueStore,
  refreshMessageQueue,
  removeMessage,
  stashPendingBody,
  takePendingBody,
} from "./message-queue-store";
import { textFromParts } from "./queue-items";
import { useMessageQueueActions } from "./use-message-queue";
import { formatDeckTabId } from "@/layouts/main-panel-tabs/tab-id";
import { useEffectiveSimpleMode } from "../../hooks/use-user-model-preferences";
import {
  findModel,
  pickFallbackChatModel,
  resolveActiveTier,
  type ModelRef,
  type SimpleTier,
} from "./resolve-chat-model";

// ============================================================================
// Context Types
// ============================================================================

export interface ChatStreamContextValue {
  messages: ChatMessage[];
  status: "ready" | "submitted" | "streaming" | "error";
  sendMessage: (
    params: SendMessageParams | Metadata["tiptapDoc"],
  ) => Promise<void>;
  /** Edit a QUEUED (not-yet-running) message: cancel its gate workflow and
   *  re-POST the edited text as a fresh message (re-enqueues at the queue
   *  tail — see the implementation). Resolves true when the edited message
   *  was dispatched OK; false on ANY failure (latch drop, cancel failure,
   *  failed re-POST) — callers must keep the user's draft alive on false.
   *  Every failure path surfaces its own toast. */
  editQueuedMessage: (messageId: string, text: string) => Promise<boolean>;
  stop: () => void;
  /** Single mutator entry point — new user message, tool output, or approval
   *  response. Patches local messages, clears finishReason, POSTs to /messages.
   *  Throws if a toolOutput / approval target isn't found in current messages. */
  submit: (action: SubmitAction, opts: RequestOptions) => Promise<void>;
  /** Drop a message from the local body store. Used after a CONFIRMED cancel
   *  of a queued turn: a reload/refetch can preload the queued message's
   *  persisted row into the local store (render-hidden only while it stays
   *  queued) — cancelling would otherwise unhide it as a stale, forever-
   *  unanswered bubble. Removing an absent id is a no-op, so callers invoke
   *  it unconditionally after the server confirms the cancel. */
  removeLocalMessage: (messageId: string) => void;
  /** Synchronous probe for the module-level `sendInFlight` latch (same key
   *  `sendMessageInternal` latches on: this task's id). Lets callers that
   *  clear UI state right after firing `sendMessage` (e.g. the composer's
   *  draft) check FIRST whether that send will actually be accepted or
   *  silently dropped by the latch, so they don't destroy state for a send
   *  that never happened. */
  isSendInFlight: () => boolean;
  error: Error | null;
  clearError: () => void;
  finishReason: string | null;
  runStatusStage: RunStatusStage | null;
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
  /** True iff the thread row has captured a `harness_id` — i.e. the first
   *  message has been processed and the runtime is pinned for life. */
  isThreadLocked: boolean;
  /** Locked harness for the active thread (null when unlocked / no thread). */
  lockedHarness: HarnessId | null;
  /** Locked sandbox provider kind (null when unlocked, or harness has no sandbox). */
  lockedSandbox: SandboxProviderKind | null;
  /** Locked branch (null when unlocked or thread has no branch). */
  lockedBranch: string | null;
  /** thread.branch — alias of `lockedBranch`. Null until the user picks one or
   *  the server assigns the default. */
  currentBranch: string | null;
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
  /** Selected quick web search model (null = no web search models available) */
  webSearchModel: AiProviderModel | null;
  setWebSearchModel: (model: AiProviderModel | null) => void;
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
   * (cloud org router / Claude Code on desktop / Codex on desktop). Single
   * source of truth for the (harness, sandbox) pair — see `AGENT_OPTION_PINS`
   * in `./pills/agent-options`. Chosen inside the model selector.
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
  const [storedWebSearchRef, setStoredWebSearchRef] =
    useLocalStorage<ModelRef | null>(
      LOCALSTORAGE_KEYS.chatSelectedWebSearchModel(locator),
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

  // Simple Model Mode (org config with this user's chat-tier overrides layered on)
  const simpleMode = useEffectiveSimpleMode();
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
  const { models: simpleWebSearchModels } = useAiProviderModels(
    simpleMode.tiers.web_search?.keyId,
  );
  const { models: simpleDeepResearchModels } = useAiProviderModels(
    simpleMode.tiers.deep_research?.keyId,
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

  // Quick web search models (Sonar / search-preview / online, streaming) —
  // excludes async-only deep models. Shared classifier with settings + the
  // SDK default-picker so the three never drift.
  const webSearchModels = allKeyModels.filter(isQuickSearchModel);
  const validatedStoredWebSearch = findModel(
    storedWebSearchRef,
    keys,
    webSearchModels,
  );
  const defaultWebSearchModel =
    webSearchModels.find((m) => m.modelId === "perplexity/sonar") ??
    webSearchModels[0] ??
    null;
  const resolvedWebSearchModel: AiProviderModel | null =
    findModel(
      simpleMode.tiers.web_search,
      keys,
      simpleWebSearchModels,
      simpleMode.tiers.web_search?.title,
    ) ??
    validatedStoredWebSearch ??
    defaultWebSearchModel;

  // Deep research models (async / deep-research, sonar-pro fallback).
  const deepResearchModels = allKeyModels.filter(isDeepResearchModel);
  const validatedStoredDeepResearch = findModel(
    storedDeepResearchRef,
    keys,
    deepResearchModels,
  );
  const defaultDeepResearchModel =
    deepResearchModels.find((m) => m.modelId === "perplexity/deep-research") ??
    deepResearchModels.find((m) => m.asyncResearch === true) ??
    deepResearchModels[0] ??
    null;
  const resolvedDeepResearchModel: AiProviderModel | null =
    findModel(
      simpleMode.tiers.deep_research,
      keys,
      simpleDeepResearchModels,
      simpleMode.tiers.deep_research?.title,
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
  // pick (cloud org router / Claude Code on desktop / Codex on desktop).
  // Persisted to localStorage so the choice survives page reloads.
  //
  // Scoped per `locator` (like the image-model and tier prefs) so a desktop
  // pick made in one org doesn't leak into another — runtime availability is
  // org/link-specific, and a "Claude Code desktop" pick carried across orgs
  // used to mis-route to an offline link. A fresh org starts with no pick
  // (`null`), letting the server choose its default.
  //
  // Everything else (`pendingHarnessId`, `pendingSandboxProviderKind`,
  // the request body's harnessId/sandboxProviderKind) derives from this
  // through `AGENT_OPTION_PINS`, so the pill display and the submit can
  // never disagree.
  const [pendingAgentOption, setPendingAgentOption] =
    useLocalStorage<AgentOption | null>(
      LOCALSTORAGE_KEYS.chatLastAgentOption(locator),
      (existing) =>
        existing && existing in AGENT_OPTION_PINS ? existing : null,
    );

  // Provider-tree wiring: `ChatPrefsProvider` is mounted INSIDE
  // `ChatTaskCtx.Provider` (see `ChatContextProvider` below), so the optional
  // task hook resolves the active-thread lock state in the full chat mount.
  // On `/$org/` (standalone home composer) there is no task context — the
  // hook returns `null` and we fall through to the user's global picker.
  // This is option (b) from the plan: read the inner context here rather
  // than hoist active-task knowledge into the outer provider, which would
  // require restructuring the standalone mount path.
  const taskCtxForLock = useOptionalChatTask();
  const lockedAgentOption =
    taskCtxForLock?.isThreadLocked && taskCtxForLock.lockedHarness != null
      ? agentOptionFor(
          taskCtxForLock.lockedHarness,
          taskCtxForLock.lockedSandbox,
        )
      : null;

  // Capability probes are advisory — we don't rewrite the harness for a missing
  // CLI (cloud chat via the org router works even where the cloud *sandbox*
  // doesn't). The one exception is a desktop pick whose link is *confirmed*
  // offline: it can't run anywhere and nothing prompted the user to reconnect,
  // so we auto-switch it to cloud. Derived (not persisted), so the desktop pick
  // returns on its own once the link reconnects.
  const link = useCurrentLink();
  const selectedAgentOption = resolveOfflineAgentOption(
    pendingAgentOption,
    link.ready && !link.online,
  );

  // When the thread is locked, the agent option is dictated by the persisted
  // (harness, sandbox) pair — period. Otherwise, fall through to the user's
  // selected global picker.
  //
  // When the thread is locked but the (harness, sandbox) tuple doesn't map
  // to a known AgentOption (legacy/trigger-created rows), we intentionally
  // surface `null` here rather than falling through to the global picker.
  // The submit path is server-enforced anyway; consumers (pills, etc.)
  // should consult isThreadLocked for the "locked" affordance and avoid
  // showing the global selection on a locked thread.
  const effectiveAgentOption: AgentOption | null =
    taskCtxForLock?.isThreadLocked ? lockedAgentOption : selectedAgentOption;

  const effectivePins = effectiveAgentOption
    ? AGENT_OPTION_PINS[effectiveAgentOption]
    : null;
  const pendingHarnessId = effectivePins?.harness ?? null;
  const pendingSandboxProviderKind: SandboxProviderKind | null =
    effectivePins?.sandbox ?? null;

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
    webSearchModel: resolvedWebSearchModel,
    setWebSearchModel: (model: AiProviderModel | null) => {
      setStoredWebSearchRef(
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
  const lockedHarness = (activeTask?.harness_id ?? null) as HarnessId | null;
  const lockedSandbox = (activeTask?.sandbox_provider_kind ??
    null) as SandboxProviderKind | null;
  const lockedBranch = activeTask?.branch ?? null;
  const isThreadLocked = lockedHarness != null;

  // The stored thread branch is authoritative for sandbox dispatch.
  const currentBranch = lockedBranch;

  // Create the row up-front. The server assigns the default branch, and the
  // route loader's useEnsureTask skips its create-on-404 fallback.
  const createTask = (): string => {
    const newId = crypto.randomUUID();
    void threadActions
      .create({
        id: newId,
        virtual_mcp_id: virtualMcpId,
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
  // task's ActiveTaskProvider fires it on mount.
  const createTaskWithMessage = (params: {
    message: SendMessageParams;
    virtualMcpId?: string;
  }) => {
    const newId = crypto.randomUUID();
    const targetVmcp = params.virtualMcpId ?? virtualMcpId;
    writeStoredAutosend(sessionStorage, locator, newId, params.message);
    void threadActions
      .create({
        id: newId,
        virtual_mcp_id: targetVmcp,
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
    isThreadLocked,
    lockedHarness,
    lockedSandbox,
    lockedBranch,
    currentBranch,
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
  const t = useT();
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
    webSearchModel,
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
    throw new Error(t("chat.chatContext.activeTaskProviderMissingContext"));
  }

  const { user, contextPrompt, preferences, rawNavigateToTask } = internals;

  const { org, locator } = useProjectContext();
  const queueActions = useMessageQueueActions();

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
  const runStatusStage = useStore(conn.runStatusStage);
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
    orgId: org.id,
    orgSlug: org.slug,
  });
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  cbRef.current = {
    onToolCall,
    queryClient,
    rawNavigateToTask,
    taskId,
    manager,
    navigate,
    orgId: org.id,
    orgSlug: org.slug,
  };

  // Race-free body reconcile for queued turns. When a message is sent behind a
  // running turn it's queued on the thread gate; the dequeued run's reply is
  // NOT streamed to this thread's open /stream (a desktop run dispatches only
  // after the gate slot frees, and its content lands only in the DB via the
  // projector). The projector/run-reactor emit `decopilot.thread.status` on the
  // shared /api/:org/watch pool STRICTLY AFTER that turn's thread_message_parts
  // are durably committed (projector path: enforced by DBOS step journaling —
  // the parts step is recorded before the terminal-status step runs). So one
  // refetch on this event always sees the reply: no sleep, no retry, no timer.
  // The event carries only `subject = threadId` (no per-run id), so we resync
  // the whole list via `reconcileFromServer` (idempotent, DB-authoritative).
  // Delivery is at-most-once (NATS Core, no replay): a dropped event self-heals
  // because any LATER same-thread status event re-reconciles. Scoped to threads
  // that actually queued work (`isQueueDirty`) so normal threads are untouched.
  useDecopilotEvents({
    orgSlug: org.slug,
    taskId,
    onTaskStatus: (event) => {
      const cb = cbRef.current;
      const messageId = event.data.message_id;
      if (event.data.status === "in_progress" && messageId) {
        // The gate started executing this queued message — flip tray → body.
        removeMessage(cb.taskId, messageId);
        const stashed = takePendingBody(cb.taskId, messageId);
        if (stashed) conn.applyLocalMessage(stashed);
        void refreshMessageQueue(cb.orgSlug, cb.taskId); // authoritative re-sync
      }
      if (!isQueueDirty(cb.taskId)) return;
      void (async () => {
        await refreshMessageQueue(cb.orgSlug, cb.taskId);
        const applied = await conn.reconcileFromServer();
        // The gate queue has drained — the last queued turn finished and its
        // parts are committed (guaranteed by the ordering above), so the body
        // is whole. Stop reconciling until the next time work is queued.
        // Gate on `applied`: `reconcileFromServer` skips its apply while the
        // next queued turn is already mid-stream (racing dequeue) — and by
        // then the gate queue can look drained. The flag must survive the
        // skip so that turn's own terminal event retries the reconcile.
        if (applied && messageQueueStore(cb.taskId).get().length === 0) {
          clearQueueDirty(cb.taskId);
        }
      })();
    },
  });

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
        // Deck preview (slides skill): the harness emits `data-deck-updated`
        // when `decks/<name>.html` changes in the org home volume. Refresh
        // the stat (rolls the deck tab's cache-busted iframe src) and
        // auto-open the tab — latest deck wins, like html pages above.
        if (chunk.type === "data-deck-updated") {
          const data = (chunk as unknown as { data: { path?: string } }).data;
          if (!data?.path) return;
          const path = data.path;
          const cb = cbRef.current;
          cb.queryClient.invalidateQueries({
            queryKey: KEYS.orgFsStat(cb.orgId, "home", path),
          });
          cb.queryClient.invalidateQueries({
            queryKey: KEYS.orgFsRecent(cb.orgId),
          });
          cb.navigate({
            to: ".",
            search: (prev: Record<string, unknown>) => ({
              ...prev,
              main: formatDeckTabId(path),
            }),
            replace: true,
          });
          return;
        }
        // `load_repo` finished cloning a repo into the thread's sandbox. Patch
        // the local thread row (branch + repo + sandbox record) so the preview
        // resolves without a refetch, then open the "preview" main-panel tab.
        if (chunk.type === "data-open-preview") {
          const data = (
            chunk as unknown as {
              data: {
                branch?: string | null;
                githubRepo?: unknown;
                sandboxMap?: unknown;
                sandboxProviderKind?: string | null;
              };
            }
          ).data;
          const cb = cbRef.current;
          const id = cb.taskId;
          if (id) {
            const current = cb.manager.threads.get().find((t) => t.id === id);
            cb.manager.patchThread({
              id,
              ...(data?.branch ? { branch: data.branch } : {}),
              ...(data?.sandboxProviderKind
                ? {
                    sandbox_provider_kind:
                      data.sandboxProviderKind as Task["sandbox_provider_kind"],
                  }
                : {}),
              metadata: {
                ...(current?.metadata ?? {}),
                ...(data?.githubRepo ? { githubRepo: data.githubRepo } : {}),
                ...(data?.sandboxMap ? { sandboxMap: data.sandboxMap } : {}),
              } as Task["metadata"],
            });
          }
          cb.navigate({
            to: ".",
            search: (prev: Record<string, unknown>) => ({
              ...prev,
              main: "preview",
            }),
            replace: true,
          });
          return;
        }
      },
      onFinish: (message, _messages, finishReason) => {
        const cb = cbRef.current;
        // Terminal event: the gate advanced — re-sync the queue so the
        // dequeued message drops and the next one surfaces.
        if (cb.taskId) void refreshMessageQueue(cb.orgSlug, cb.taskId);
        if (cb.taskId) {
          cb.manager.patchThread({
            id: cb.taskId,
            status: deriveTerminalThreadStatus(
              finishReason,
              message.parts as {
                type?: string;
                text?: string;
                state?: string;
              }[],
            ),
            updated_at: new Date().toISOString(),
          });
        }
        // Refresh download chips only when this turn could have produced a
        // file: an explicit share, or sandbox file work (bash/write can drop
        // results into `org/output/`). AI SDK v5 surfaces tool invocations as
        // `tool-<name>` parts; `output-available` skips denied/cancelled calls.
        const sharedFile = message.parts?.some((p) => {
          const part = p as { type: string; state?: string };
          return (
            (part.type === "tool-share_with_user" ||
              part.type === "tool-bash" ||
              part.type === "tool-write") &&
            part.state === "output-available"
          );
        });
        if (cb.taskId && sharedFile) {
          const key = KEYS.threadOutputs(cb.taskId);
          // org/output files reach the manifest ~5s after the sandbox closes
          // them (rclone write-back), so a file written in the turn's last
          // seconds misses an immediate refresh. Sweep a few times across a
          // generous flush window — each sweep is one indexed query, and
          // share_with_user uploads (synchronous) are covered by the first.
          for (const delayMs of [0, 1_500, 3_000, 6_000, 12_000, 25_000]) {
            setTimeout(() => {
              cb.queryClient.invalidateQueries({ queryKey: key });
            }, delayMs);
          }
        }

        // The "what's next for this agent" hint is derived server-side from
        // org state (brand exists? has pages? connections healthy?). Any turn
        // can flip that state, so re-fetch on every finish — covers both
        // `mine=true` and `mine=false` variants via partial-key match.
        cb.queryClient.invalidateQueries({
          queryKey: KEYS.homeNextActions(cb.orgSlug),
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

    // Seed the frontend message queue from the gate on (re)mount so a reload
    // or thread switch still shows what's queued.
    void refreshMessageQueue(cbRef.current.orgSlug, cbRef.current.taskId);

    // Keep the queue PANEL in sync on every local run start/end edge (the live
    // stream's own status). This is panel-only; the body reconcile for queued
    // turns is driven separately off `decopilot.thread.status` (see
    // `useDecopilotEvents` above), which — unlike this live-stream edge — is
    // guaranteed to fire only AFTER the run's parts are durably committed.
    const isActiveStatus = (k: ConnStatus["kind"]) =>
      k === "submitted" || k === "streaming";
    let prevActive = isActiveStatus(conn.status.get().kind);
    const unsubStatus = conn.status.subscribe(() => {
      const active = isActiveStatus(conn.status.get().kind);
      if (active === prevActive) return;
      prevActive = active;
      const cb = cbRef.current;
      void refreshMessageQueue(cb.orgSlug, cb.taskId);
    });

    return () => {
      if (conn.observer === observer) conn.observer = null;
      unsubStatus();
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

  // Shared tail for dispatching a fresh user message — used by BOTH a plain
  // composer send (sendMessageInternal) and a re-POSTed queued-message edit
  // (editQueuedMessage). Builds requestOptions from the current thread/prefs
  // state, then either queues the message behind an in-progress run or
  // submits it immediately. Owns releasing the `sendInFlight` latch (finally):
  // callers are responsible for the synchronous latch check + add BEFORE
  // calling this, so a re-entrant call is rejected before any work happens.
  //
  // Resolves `true` when the message was handed off (queued or submitted).
  // The enqueue branch handles its own errors (toast + chatError, never
  // rethrows) and resolves `false` on failure so edit-flow callers can react;
  // the immediate-submit branch still RETHROWS on failure — unchanged
  // plain-send behavior (sendMessageInternal ignores the return value).
  async function dispatchUserMessage(message: ChatMessage): Promise<boolean> {
    // Capture at dispatch time (frozen in closure)
    const capturedTaskId = taskId;
    // The message's own agent wins over the thread's current one: an "@agent"
    // mention hands THIS turn to that agent (see sendMessageInternal), so a
    // room can hold several agents without the user leaving the thread.
    const capturedVirtualMcpId = message.metadata?.agent?.id ?? virtualMcpId;

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
    if (modeToSend === "web-search" && !webSearchModel) {
      modeToSend = "default";
    }
    if (modeToSend === "deep-research" && !deepResearchModel) {
      modeToSend = "default";
    }
    // Plan and gen-image modes are sticky — the user explicitly toggles them
    // off. Web-search and deep-research are one-shot (reset after each send).
    if (modeToSend === "web-search" || modeToSend === "deep-research") {
      setChatMode("default");
    }

    const submitSettings = resolveSubmitSettings({
      thread: activeTask
        ? {
            harness_id: activeTask.harness_id ?? null,
            sandbox_provider_kind: activeTask.sandbox_provider_kind ?? null,
            branch: activeTask.branch ?? null,
          }
        : null,
      globals: {
        harnessId: pendingHarnessId ?? undefined,
        sandboxProviderKind: pendingSandboxProviderKind ?? undefined,
        branch: currentBranch,
      },
    });

    // First message on an unlocked thread: the server pins harness_id /
    // sandbox_provider_kind on receipt, but that write never flows back through
    // `/watch` (RowPatch carries it, the SSE event does not). Mirror the
    // harness into the store now so `findReusableNewChat` stops treating the
    // (now non-empty, often just-failed) thread as an empty "New chat" and
    // dropping the user back onto it. When the user hasn't explicitly picked a
    // runtime the client sends no harnessId and the server pins its default
    // ("decopilot", per resolveHarnessId's fallback for non-CLI providers) —
    // mirror that so this covers the common brand-new-thread case, not just
    // explicit picks. LIST/GET is authoritative; this only keeps the live view
    // correct meanwhile.
    //
    // `sandbox_provider_kind` is deliberately NOT mirrored: the server resolves
    // it from state the client doesn't own (notably whether a desktop link is
    // live), so the picker's value is a guess that the server routinely
    // contradicts — it pins `user-desktop` for a linked desktop while the
    // picker says `agent-sandbox`. Writing the guess made the preview's entry
    // lookup miss a running sandbox, blanking a working preview and booting a
    // competing one. Leave the field null until the authoritative row lands.
    if (!activeTask?.harness_id) {
      manager.patchThread({
        id: capturedTaskId,
        harness_id: submitSettings.harnessId ?? "decopilot",
        updated_at: new Date().toISOString(),
      });
    }

    const requestOptions: RequestOptions = {
      tier: activeTier,
      mode: modeToSend,
      toolApprovalLevel:
        preferences.toolApprovalLevel ?? readToolApprovalLevel(),
      system: system || undefined,
      agent: { id: capturedVirtualMcpId },
      thread_id: capturedTaskId,
      ...submitSettings,
    };

    // A run is already streaming (this thread) or in progress (hosted): this
    // message can't be the current turn, so queue it behind the running one.
    // It stays tray-only — nothing renders in the body — until the gate's
    // `in_progress` event carries this message's id; the full message is
    // stashed now so that dispatch-time flip can apply it with zero fetches.
    // Otherwise this is the current turn — submit normally so it streams
    // immediately.
    try {
      if (isStreaming || isRunInProgress) {
        let queuedOk = true;
        try {
          stashPendingBody(capturedTaskId, message);
          await conn.enqueue(message, requestOptions);
          enqueueMessage(capturedTaskId, {
            workflowId: `thread-run:${capturedTaskId}:${message.id}`,
            messageId: message.id,
            text: textFromParts(message.parts),
            // Computed locally so the tray's edit affordance is correct from
            // the first render — leaving this undefined for one server
            // round-trip would offer "edit" on an attachment-bearing turn,
            // and an edit taken in that window drops the attachment for good.
            hasAttachments: message.parts.some((p) => p.type === "file"),
            status: "queued",
            enqueuedAt: Date.now(),
            optimistic: true,
          });
          // The body now trails the gate: this queued turn's reply will fold
          // into a transient stream id when it dequeues and never lands in
          // the body on its own. Mark the thread dirty so each run terminal
          // reconciles the body against the server until the queue drains.
          markQueueDirty(capturedTaskId);
        } catch (err) {
          // The POST never landed — nothing was appended to the body, so
          // just drop the stash and the optimistic tray entry.
          queuedOk = false;
          dropPendingBody(capturedTaskId, message.id);
          removeMessage(capturedTaskId, message.id);
          setChatError(err instanceof Error ? err : new Error(String(err)));
          toast.error(
            err instanceof Error
              ? err.message
              : t("chat.chatContext.failedToQueueMessage"),
          );
        }
        // Reconcile the optimistic row against the gate's authoritative list.
        void refreshMessageQueue(org.slug, capturedTaskId);
        return queuedOk;
      }
      await conn.submit({ kind: "message", message }, requestOptions);
      return true;
    } finally {
      sendInFlight.delete(capturedTaskId);
    }
  }

  // sendMessage — captures context at call time
  async function sendMessageInternal(params: SendMessageParams): Promise<void> {
    const parts = params.parts ?? derivePartsFromTiptapDoc(params.tiptapDoc);
    if (parts.length === 0) return;

    // Synchronous per-thread latch — drop a re-entrant send (double-Enter)
    // before it mints a second message id and double-queues the draft.
    if (sendInFlight.has(taskId)) return;
    sendInFlight.add(taskId);

    // Drop any error banner from a prior turn — explicitly sending a new
    // message means the user has moved on and a stale "network error"
    // toast on top of a fresh request is just noise. (finishReason is
    // cleared inside conn.submit synchronously.)
    setChatError(null);
    setTiptapDoc(undefined);

    // "@agent" in the draft addresses that agent: it answers this turn itself,
    // in this thread, as itself — that's what makes a thread a room with more
    // than one agent in it. With no mention the thread's current agent answers.
    // Recorded on the message so every later reader (the attribution UI, and
    // the server's history relabelling) can tell who spoke without a new column.
    const mentioned = extractMentionedAgentId(params.tiptapDoc);

    const messageMetadata: Metadata = {
      tiptapDoc: params.tiptapDoc,
      created_at: new Date().toISOString(),
      agent: mentioned
        ? { id: mentioned.agentId, title: mentioned.title }
        : { id: virtualMcpId },
      user: {
        avatar: user?.image ?? undefined,
        name: user?.name ?? "you",
      },
    };

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts,
      metadata: messageMetadata,
    };

    await dispatchUserMessage(userMessage);
  }

  // Edit a QUEUED message: cancel the old gate workflow (server also deletes
  // its persisted parts), then re-POST the edited text as a fresh message —
  // which re-enqueues at the queue TAIL (DBOS workflow ids are once-ever; an
  // accepted trade-off, only observable with 2+ queued). Text-only by design.
  //
  // Resolves `true` only when the edited message was dispatched OK; `false`
  // on any failure (latch drop, cancel failure, failed re-POST) so the tray
  // can keep the user's draft alive instead of discarding it. Every false
  // path surfaces its own toast.
  async function editQueuedMessage(
    messageId: string,
    text: string,
  ): Promise<boolean> {
    // Same synchronous per-thread latch sendMessageInternal uses — an edit
    // is itself a dispatch, so it must not race a concurrent send/edit. The
    // tray probes isSendInFlight() before calling, so this drop is a
    // belt-and-braces guard — but report it honestly rather than resolving
    // as if the edit happened.
    if (sendInFlight.has(taskId)) {
      toast.info(t("chat.chatContext.stillSendingPreviousMessage"));
      return false;
    }
    sendInFlight.add(taskId);

    const ok = await queueActions.cancel(taskId, messageId);
    if (!ok) {
      sendInFlight.delete(taskId);
      toast.error(t("chat.chatContext.couldNotRemoveOriginalMessage"));
      return false;
    }
    dropPendingBody(taskId, messageId);
    // A reload/refetch may have preloaded the original queued message's
    // persisted row into the local body store (render-hidden only while it
    // stayed queued). The cancel just deleted its server parts and its
    // queue entry — drop the stale local row too or the ORIGINAL text
    // resurrects as a forever-unanswered bubble while the edited text is
    // queued. Removing an absent id is a no-op, so call unconditionally.
    conn.removeLocalMessage(messageId);

    const edited: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text }],
      metadata: {
        created_at: new Date().toISOString(),
        user: {
          avatar: user?.image ?? undefined,
          name: user?.name ?? "you",
        },
      },
    };
    // Reuse the exact enqueue-or-submit branch sendMessageInternal runs.
    // The enqueue branch resolves false on failure (it toasts internally);
    // the immediate-submit branch rethrows instead — map that to false too
    // (with its own toast) so the tray sees one honest boolean either way.
    try {
      return await dispatchUserMessage(edited);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("chat.chatContext.failedToSendEditedMessage"),
      );
      return false;
    }
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
        throw new Error(
          data.message ??
            t("chat.chatContext.cancelFailedStatus", { status: res.status }),
        );
      }
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : t("chat.chatContext.failedToCancel");
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

  const streamValue: ChatStreamContextValue = {
    messages,
    status: statusToString(connStatus),
    sendMessage: sendMessagePublic,
    editQueuedMessage,
    stop: () => void cancelRun(),
    submit: (action, opts) => conn.submit(action, opts),
    removeLocalMessage: (messageId) => conn.removeLocalMessage(messageId),
    isSendInFlight: () => sendInFlight.has(taskId),
    error: chatError,
    clearError: () => setChatError(null),
    finishReason,
    runStatusStage,
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
  const t = useT();
  const ctx = useContext(ChatStreamCtx);
  if (!ctx) throw new Error(t("chat.chatContext.useChatStreamMissingContext"));
  return ctx;
}

export function useOptionalChatStream(): ChatStreamContextValue | null {
  return useContext(ChatStreamCtx);
}

export function useChatTask(): ChatTaskContextValue {
  const t = useT();
  const ctx = useContext(ChatTaskCtx);
  if (!ctx) throw new Error(t("chat.chatContext.useChatTaskMissingContext"));
  return ctx;
}

export function useChatPrefs(): ChatPrefsContextValue {
  const t = useT();
  const ctx = useContext(ChatPrefsCtx);
  if (!ctx) throw new Error(t("chat.chatContext.useChatPrefsMissingContext"));
  return ctx;
}

export function useOptionalChatPrefs(): ChatPrefsContextValue | null {
  return useContext(ChatPrefsCtx);
}

export function useOptionalChatTask(): ChatTaskContextValue | null {
  return useContext(ChatTaskCtx);
}

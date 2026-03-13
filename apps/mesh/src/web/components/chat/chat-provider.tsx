/**
 * ChatProvider — initialises the ChatStore and bridges React-managed
 * data (virtual MCPs, models, React Query, SSE) into the singleton store.
 *
 * Renders ChatBridge (useAIChat adapter) and ThreadListSync (React Query → store).
 */

import {
  selectDefaultModel,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import { useQueryClient } from "@tanstack/react-query";
import {
  Suspense,
  useEffect,
  useRef,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import {
  useAiProviderKeyList,
  useAiProviderModels,
} from "../../hooks/collections/use-llm";
import { useContext as useContextHook } from "../../hooks/use-context";
import { useDecopilotEvents } from "../../hooks/use-decopilot-events";
import { useNotification } from "../../hooks/use-notification";
import { usePreferences } from "../../hooks/use-preferences";
import { authClient } from "../../lib/auth-client";
import { KEYS } from "../../lib/query-keys";
import { ErrorBoundary } from "../error-boundary";
import { ChatBridge } from "./chat-bridge";
import { chatStore } from "./store/chat-store";
import { useActiveThreadId, useChatStore } from "./store/selectors";
import { useTaskManager } from "./task";

// ============================================================================
// ThreadListSync — bridges React Query thread data into the store
// ============================================================================

function ThreadListSync() {
  const taskManager = useTaskManager();
  const activeThreadId = useActiveThreadId();

  // Sync threads, pagination, and messages into store after render
  // to avoid "cannot update component while rendering another" warnings.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    chatStore.setThreads(taskManager.tasks);
    chatStore.setPagination({
      hasNextPage: taskManager.hasNextPage ?? false,
      isFetchingNextPage: taskManager.isFetchingNextPage ?? false,
      fetchNextPage: taskManager.fetchNextPage,
    });
    chatStore.mergeMessages(activeThreadId, taskManager.messages);

    if (taskManager.activeTaskId !== activeThreadId) {
      taskManager.setActiveTaskId(activeThreadId);
    }
  });

  // Expose taskManager's updateMessagesCache to the store
  const taskManagerRef = useRef(taskManager);
  taskManagerRef.current = taskManager;
  chatStore.setCacheHelpers({
    updateMessagesCache: (threadId, messages) => {
      taskManagerRef.current.updateMessagesCache(threadId, messages);
    },
    hideTask: (taskId) => taskManagerRef.current.hideTask(taskId),
    renameTask: (taskId, title) =>
      taskManagerRef.current.renameTask(taskId, title),
    createTask: () => {
      return taskManagerRef.current.createTask();
    },
  });

  return null;
}

// ============================================================================
// TaskStreamManager — manages stream resumption, SSE, and safety-net polling.
// Keyed by activeThreadId so it remounts on thread switch.
// ============================================================================

const SAFETY_NET_POLL_MS = 30_000;
const getSnapshotStub = () => 0;
const MAX_RESUME_RETRIES = 3;

function TaskStreamManager({ threadId }: { threadId: string }) {
  const orgId = useChatStore((s) => s.org.id);
  const locator = useChatStore((s) => s.locator);
  const queryClient = useQueryClient();

  const hasResumedRef = useRef<string | null>(null);
  const resumeFailCountRef = useRef(0);

  const invalidateThreadList = () => {
    queryClient.invalidateQueries({ queryKey: KEYS.tasks(locator) });
  };

  const invalidateMessages = () => {
    if (!threadId) return;
    queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        if (key[3] !== "collection" || key[4] !== "THREAD_MESSAGES") {
          return false;
        }
        const serialized = typeof key[6] === "string" ? key[6] : "";
        return serialized.includes(threadId);
      },
    });
  };

  const isChatActive = () => {
    const s = chatStore.getSnapshot().status;
    return s === "submitted" || s === "streaming";
  };

  const tryResumeStream = (reason: string) => {
    if (!threadId || hasResumedRef.current === threadId) return;
    if (resumeFailCountRef.current >= MAX_RESUME_RETRIES) return;
    if (isChatActive()) return;
    hasResumedRef.current = threadId;

    console.log(`[chat] resumeStream (${reason})`, threadId);
    chatStore.resumeStream().catch((err: unknown) => {
      console.error("[chat] resumeStream error", err);
      resumeFailCountRef.current++;
      hasResumedRef.current = null;
      invalidateThreadList();
      invalidateMessages();
    });
  };

  useDecopilotEvents({
    orgId,
    taskId: threadId,
    onStep: () => tryResumeStream("sse-step"),
    onFinish: () => {
      if (!isChatActive()) {
        hasResumedRef.current = null;
        resumeFailCountRef.current = 0;
        invalidateThreadList();
        setTimeout(invalidateMessages, 2000);
      }
    },
    onTaskStatus: () => {
      if (!isChatActive()) {
        invalidateThreadList();
      }
    },
  });

  // Safety-net polling when run is in_progress but no active stream
  const isRunInProgress = useChatStore((s) => {
    const thread = s.threads.find((t) => t.id === s.activeThreadId);
    return (
      (thread?.status === "in_progress" || thread?.status === "expired") &&
      s.status === "ready"
    );
  });

  const subscribe = (_onStoreChange: () => void) => {
    if (!isRunInProgress) return () => {};

    tryResumeStream("page-load");

    const id = setInterval(() => {
      invalidateThreadList();
      invalidateMessages();
    }, SAFETY_NET_POLL_MS);
    return () => clearInterval(id);
  };

  useSyncExternalStore(subscribe, getSnapshotStub, getSnapshotStub);

  return null;
}

// ============================================================================
// ReactSyncer — syncs React hook data into the store
// ============================================================================

function ReactSyncer() {
  const virtualMcps = useVirtualMCPs();
  const keys = useAiProviderKeyList();
  const [preferences] = usePreferences();
  const { showNotification } = useNotification();
  const credentialId = useChatStore((s) => s.credentialId);

  // Resolve effective key ID
  const effectiveKeyId = keys.some((k) => k.id === credentialId)
    ? credentialId
    : (keys[0]?.id ?? null);

  // Load models for auto-select
  const { models: defaultKeyModels, isLoading: isModelsQueryLoading } =
    useAiProviderModels(effectiveKeyId ?? undefined);
  const effectiveProviderId =
    keys.find((k) => k.id === effectiveKeyId)?.providerId ?? "anthropic";
  const defaultModel = selectDefaultModel(
    defaultKeyModels,
    effectiveProviderId,
    effectiveKeyId ?? undefined,
  );

  // Context prompt
  const storedVirtualMcpId = useChatStore((s) => s.selectedAgent?.id ?? null);
  const contextPrompt = useContextHook(storedVirtualMcpId);

  // Sync into store after render to avoid "cannot update component
  // while rendering another" warnings.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    chatStore.setVirtualMcps(virtualMcps);
    chatStore.setAllModelsConnections(keys);
    chatStore.setContextPrompt(contextPrompt);
    chatStore.setToolApprovalLevel(preferences.toolApprovalLevel);
    chatStore.setNotificationHandler(
      showNotification,
      preferences.enableNotifications ?? false,
    );
    chatStore.setDefaultModel(
      defaultModel,
      !chatStore.getSnapshot().selectedModel && isModelsQueryLoading,
    );

    if (effectiveKeyId !== credentialId) {
      chatStore.setCredentialId(effectiveKeyId);
    }
  });

  return null;
}

// ============================================================================
// ChatProvider
// ============================================================================

export function ChatProvider({ children }: PropsWithChildren) {
  const { locator, org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const user = session?.user ?? null;
  const isInitialized = useChatStore((s) => !!s.org.slug);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (!org) return;

    chatStore.init({
      org,
      locator,
      user: user ? { name: user.name, image: user.image ?? undefined } : null,
    });
    return () => chatStore.reset();
  }, [locator]);

  const activeThreadId = useActiveThreadId();

  return (
    <>
      <ErrorBoundary fallback={null}>
        <Suspense fallback={null}>
          <ReactSyncer />
          <ThreadListSync />
          <TaskStreamManager key={activeThreadId} threadId={activeThreadId} />
        </Suspense>
      </ErrorBoundary>
      {isInitialized && <ChatBridge />}
      {children}
    </>
  );
}

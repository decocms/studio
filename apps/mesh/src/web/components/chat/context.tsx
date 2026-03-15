/**
 * Chat Context — compatibility layer over ChatStore.
 *
 * Provides useChat() and useChatStable() hooks that match the original API
 * while delegating all state to the singleton ChatStore.
 *
 * New code should import from ./store/selectors directly.
 */

import type { ToolSelectionStrategy } from "@/mcp-clients/virtual-mcp/types";
import type { McpUiUpdateModelContextRequest } from "@modelcontextprotocol/ext-apps";
import { chatStore } from "./store/chat-store";
import { useChatStore } from "./store/selectors";
import type { AiProviderModel } from "../../hooks/collections/use-llm";
import type { VirtualMCPInfo } from "./select-virtual-mcp";
import type { Task, TaskOwnerFilter } from "./task";
import type { ToolApprovalLevel } from "../../hooks/use-preferences";
import type { ChatMessage, Metadata } from "./types";

export { ChatProvider } from "./chat-provider";

// ============================================================================
// Stable value interface (matches original ChatStableValue)
// ============================================================================

interface ChatStableValue {
  tiptapDocRef: { current: Metadata["tiptapDoc"] };
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
  planMode: boolean;
  setPlanMode: (enabled: boolean) => void;

  sendMessage: (
    tiptapDoc: Metadata["tiptapDoc"],
    options?: { toolApprovalLevel?: ToolApprovalLevel },
  ) => Promise<void>;
  cancelRun: () => Promise<void>;
  setAppContext: (
    sourceId: string,
    params: McpUiUpdateModelContextRequest["params"],
  ) => void;
  clearAppContext: (sourceId: string) => void;
  allModelsConnections: ReturnType<
    typeof import("../../hooks/collections/use-llm").useAiProviderKeyList
  >;
  credentialId: string | null;
  setCredentialId: (credentialId: string | null) => void;
}

// ============================================================================
// Stream value interface (matches original ChatStreamValue)
// ============================================================================

interface ChatStreamValue {
  messages: ChatMessage[];
  status: "ready" | "submitted" | "streaming" | "error";
  setMessages: (messages: ChatMessage[]) => void;
  error: Error | null;
  clearError: () => void;
  stop: () => Promise<void>;
  addToolOutput: (...args: Parameters<typeof chatStore.addToolOutput>) => void;
  addToolApprovalResponse: (
    ...args: Parameters<typeof chatStore.addToolApprovalResponse>
  ) => void;
  isStreaming: boolean;
  isChatEmpty: boolean;
  finishReason: string | null;
  clearFinishReason: () => void;
  isWaitingForApprovals: boolean;
  isRunInProgress: boolean;
}

type ChatContextValue = ChatStableValue & ChatStreamValue;

// ============================================================================
// Hooks
// ============================================================================

/**
 * Stable chat values (model, mode, tasks, virtual MCP, actions).
 */
export function useChatStable(): ChatStableValue {
  const s = useChatStore((state) => ({
    activeTaskId: state.activeThreadId,
    tasks: state.threads,
    hasNextPage: state.hasNextPage,
    isFetchingNextPage: state.isFetchingNextPage,
    fetchNextPage: state.fetchNextPage,
    ownerFilter: state.ownerFilter,
    isFilterChangePending: state.isFilterChangePending,
    virtualMcps: state.virtualMcps,
    selectedVirtualMcp: state.selectedAgent,
    model: state.selectedModel,
    isModelsLoading: state.isModelsLoading,
    selectedMode: state.selectedMode,
    planMode: state.planMode,
    allModelsConnections: state.allModelsConnections,
    credentialId: state.credentialId,
    tiptapDoc: state.tiptapDoc,
  }));

  return {
    ...s,
    tiptapDocRef: { current: s.tiptapDoc },
    resetInteraction: () => chatStore.clearFinishReason(),
    createTask: () => chatStore.createThread(),
    switchToTask: async (taskId: string) => chatStore.setActiveThread(taskId),
    renameTask: (taskId: string, title: string) =>
      chatStore.renameTask(taskId, title),
    hideTask: (taskId: string) => {
      void chatStore.hideTask(taskId);
    },
    setVirtualMcpId: (id: string | null) => {
      const agent = id
        ? (chatStore.getSnapshot().virtualMcps.find((v) => v.id === id) ?? null)
        : null;
      chatStore.setAgent(agent);
    },
    setSelectedModel: (model: AiProviderModel) => chatStore.setModel(model),
    setSelectedMode: (mode: ToolSelectionStrategy) => chatStore.setMode(mode),
    setPlanMode: (enabled: boolean) => chatStore.setPlanMode(enabled),
    setOwnerFilter: (filter: TaskOwnerFilter) =>
      chatStore.setOwnerFilter(filter),
    sendMessage: (
      tiptapDoc: Metadata["tiptapDoc"],
      options?: { toolApprovalLevel?: ToolApprovalLevel },
    ) => chatStore.sendMessage({ tiptapDoc, ...options }),
    cancelRun: () => chatStore.cancelRun(),
    setAppContext: (sourceId, params) =>
      chatStore.setAppContext(sourceId, params),
    clearAppContext: (sourceId) => chatStore.clearAppContext(sourceId),
    setCredentialId: (id) => chatStore.setCredentialId(id),
  };
}

/**
 * Full chat context (stable + stream merged).
 */
export function useChat(): ChatContextValue {
  const stable = useChatStable();

  const stream = useChatStore((state) => {
    const messages = state.threadMessages[state.activeThreadId] ?? [];
    const isStreaming =
      state.status === "submitted" || state.status === "streaming";
    const last = messages.at(-1);
    const isWaitingForApprovals =
      !isStreaming &&
      last?.role === "assistant" &&
      last.parts.some(
        (part) => "state" in part && part.state === "approval-requested",
      );
    const thread = state.threads.find((t) => t.id === state.activeThreadId);
    const isRunInProgress =
      (thread?.status === "in_progress" || thread?.status === "expired") &&
      state.status === "ready";

    return {
      messages,
      status: state.status,
      error: state.error,
      isStreaming,
      isChatEmpty: messages.length === 0,
      finishReason: state.finishReason,
      isWaitingForApprovals: isWaitingForApprovals ?? false,
      isRunInProgress,
    };
  });

  return {
    ...stable,
    ...stream,
    setMessages: (messages: ChatMessage[]) => chatStore.setMessages(messages),
    clearError: () => chatStore.clearError(),
    stop: () => {
      chatStore.stop();
      return Promise.resolve();
    },
    addToolOutput: (...args) => chatStore.addToolOutput(...args),
    addToolApprovalResponse: (...args) =>
      chatStore.addToolApprovalResponse(...args),
    clearFinishReason: () => chatStore.clearFinishReason(),
  };
}

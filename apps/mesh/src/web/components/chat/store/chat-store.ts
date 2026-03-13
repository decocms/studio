/**
 * ChatStore — singleton store for chat state.
 *
 * React subscribes via useSyncExternalStore (see selectors.ts).
 * The store is the single source of truth; useChat from @ai-sdk/react
 * is a thin streaming adapter wired through ChatBridge.
 */

import type { ToolSelectionStrategy } from "@/mcp-clients/virtual-mcp/types";
import { getWellKnownDecopilotVirtualMCP } from "@decocms/mesh-sdk";
import type { ProjectLocator } from "@decocms/mesh-sdk";
import { DefaultChatTransport, type UIMessage } from "ai";
import { toast } from "sonner";
import type {
  AiProviderModel,
  useAiProviderKeyList,
} from "../../../hooks/collections/use-llm";
import { derivePartsFromTiptapDoc } from "../derive-parts";
import type { VirtualMCPInfo } from "../select-virtual-mcp";
import type { Task } from "../task/types";
import type { TaskOwnerFilter } from "../task/use-task-manager";
import type { ChatMessage, Metadata, MetadataModelInfo } from "../types";
import {
  readActiveThreadId,
  readOwnerFilter,
  readSelectedKeyId,
  readSelectedMode,
  readSelectedModel,
  readSelectedVirtualMcpId,
  writeActiveThreadId,
  writeOwnerFilter,
  writeSelectedKeyId,
  writeSelectedMode,
  writeSelectedModel,
  writeSelectedVirtualMcpId,
} from "./local-storage";
import type {
  ChatBridgeMethods,
  ChatStoreState,
  FinishPayload,
  SendMessageParams,
  SetAppContextParams,
} from "./types";

// ============================================================================
// Helpers
// ============================================================================

function toMetadataModelInfo(model: AiProviderModel): MetadataModelInfo {
  const caps = model.capabilities;
  const capabilities =
    caps && caps.length > 0
      ? {
          vision: caps.includes("vision") || undefined,
          text: caps.includes("text") || undefined,
          reasoning: caps.includes("reasoning") || undefined,
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

const MAX_APP_CONTEXT_LENGTH = 10_000;
const MAX_APP_CONTEXT_SOURCES = 10;

// ============================================================================
// ChatStore
// ============================================================================

class ChatStore {
  private state: ChatStoreState;
  private listeners = new Set<() => void>();
  private chatBridge: ChatBridgeMethods | null = null;

  // External deps injected from React
  private contextPrompt = "";
  private toolApprovalLevel: string | undefined;
  private showNotification:
    | ((opts: { tag: string; title: string; body: string }) => void)
    | null = null;
  private enableNotifications = false;

  // Task manager helpers injected from React
  private updateMessagesCacheFn:
    | ((threadId: string, messages: ChatMessage[]) => void)
    | null = null;
  private hideTaskFn: ((taskId: string) => Promise<void>) | null = null;
  private renameTaskFn:
    | ((taskId: string, title: string) => Promise<void>)
    | null = null;
  private createTaskFn: (() => string) | null = null;

  constructor() {
    this.state = this.defaultState();
  }

  private defaultState(): ChatStoreState {
    return {
      org: { id: "", slug: "" },
      locator: "" as ProjectLocator,
      user: null,
      activeThreadId: crypto.randomUUID(),
      threads: [],
      threadMessages: {},
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: undefined,
      ownerFilter: "me",
      isFilterChangePending: false,
      selectedModel: null,
      isModelsLoading: false,
      selectedAgent: null,
      selectedMode: "code_execution",
      credentialId: null,
      virtualMcps: [],
      allModelsConnections: [] as ReturnType<typeof useAiProviderKeyList>,
      status: "ready",
      error: null,
      finishReason: null,
      appContexts: {},
      tiptapDoc: undefined,
    };
  }

  // ---- Subscription (useSyncExternalStore compatible) ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ChatStoreState => {
    return this.state;
  };

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  // ---- Lifecycle ----

  init(ctx: {
    org: { id: string; slug: string };
    locator: ProjectLocator;
    user: { name: string; image?: string } | null;
  }): void {
    const { org, locator, user } = ctx;

    const storedModel = readSelectedModel(locator);
    const storedMode = readSelectedMode(locator);
    const storedKeyId = readSelectedKeyId(locator);
    const storedVirtualMcpId = readSelectedVirtualMcpId(locator);
    const storedActiveThreadId = readActiveThreadId(locator);
    const storedOwnerFilter = readOwnerFilter(locator);

    this.state = {
      ...this.defaultState(),
      org,
      locator,
      user,
      activeThreadId: storedActiveThreadId ?? crypto.randomUUID(),
      selectedModel: storedModel,
      selectedMode: storedMode,
      credentialId: storedKeyId,
      ownerFilter: storedOwnerFilter,
      // selectedAgent is resolved later when virtualMcps arrive
      selectedAgent: null,
    };

    // Store the virtual MCP id so setVirtualMcps can resolve it
    this._pendingVirtualMcpId = storedVirtualMcpId;

    this.notify();
  }

  private _pendingVirtualMcpId: string | null = null;

  reset(): void {
    this.chatBridge = null;
    this.state = this.defaultState();
    this.notify();
  }

  // ---- Inject React-managed deps ----

  setContextPrompt(prompt: string): void {
    this.contextPrompt = prompt;
  }

  setToolApprovalLevel(level: string | undefined): void {
    this.toolApprovalLevel = level;
  }

  setNotificationHandler(
    handler:
      | ((opts: { tag: string; title: string; body: string }) => void)
      | null,
    enabled: boolean,
  ): void {
    this.showNotification = handler;
    this.enableNotifications = enabled;
  }

  setCacheHelpers(helpers: {
    updateMessagesCache: (threadId: string, messages: ChatMessage[]) => void;
    hideTask: (taskId: string) => Promise<void>;
    renameTask: (taskId: string, title: string) => Promise<void>;
    createTask: () => string;
  }): void {
    this.updateMessagesCacheFn = helpers.updateMessagesCache;
    this.hideTaskFn = helpers.hideTask;
    this.renameTaskFn = helpers.renameTask;
    this.createTaskFn = helpers.createTask;
  }

  // ---- Thread operations ----

  createThread(): string {
    // Reset interaction state
    this.state = {
      ...this.state,
      finishReason: null,
      tiptapDoc: undefined,
    };
    this.notify();

    // Delegate to taskManager's createTask if available (handles cache + prefill)
    if (this.createTaskFn) {
      const newThreadId = this.createTaskFn();
      this.state = {
        ...this.state,
        activeThreadId: newThreadId,
        threadMessages: {
          ...this.state.threadMessages,
          [newThreadId]: [],
        },
      };
      writeActiveThreadId(this.state.locator, newThreadId);
      this.notify();
      return newThreadId;
    }

    // Fallback: create locally
    const newThreadId = crypto.randomUUID();
    this.state = {
      ...this.state,
      activeThreadId: newThreadId,
    };
    writeActiveThreadId(this.state.locator, newThreadId);
    this.notify();
    return newThreadId;
  }

  async hideTask(taskId: string): Promise<void> {
    await this.hideTaskFn?.(taskId);
  }

  async renameTask(taskId: string, title: string): Promise<void> {
    await this.renameTaskFn?.(taskId, title);
  }

  setActiveThread(threadId: string): void {
    if (threadId === this.state.activeThreadId) return;

    // Stop current stream if active
    if (this.state.status !== "ready") {
      this.stop();
    }

    this.state = {
      ...this.state,
      activeThreadId: threadId,
      tiptapDoc: undefined,
      finishReason: null,
    };
    writeActiveThreadId(this.state.locator, threadId);
    this.notify();
  }

  renameThreadLocally(threadId: string, title: string): void {
    const threads = this.state.threads.map((t) =>
      t.id === threadId
        ? { ...t, title, updated_at: new Date().toISOString() }
        : t,
    );
    this.state = { ...this.state, threads };
    this.notify();
  }

  setThreads(threads: Task[]): void {
    this.state = { ...this.state, threads };
    this.notify();
  }

  setPagination(p: {
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: (() => void) | undefined;
  }): void {
    this.state = {
      ...this.state,
      hasNextPage: p.hasNextPage,
      isFetchingNextPage: p.isFetchingNextPage,
      fetchNextPage: p.fetchNextPage,
    };
    this.notify();
  }

  setOwnerFilter(filter: TaskOwnerFilter): void {
    this.state = { ...this.state, ownerFilter: filter };
    writeOwnerFilter(this.state.locator, filter);
    this.notify();
  }

  setIsFilterChangePending(pending: boolean): void {
    this.state = { ...this.state, isFilterChangePending: pending };
    this.notify();
  }

  mergeMessages(threadId: string, serverMessages: ChatMessage[]): void {
    // During streaming for this thread, don't overwrite — streaming is fresher
    if (
      threadId === this.state.activeThreadId &&
      this.state.status !== "ready"
    ) {
      return;
    }

    this.state = {
      ...this.state,
      threadMessages: {
        ...this.state.threadMessages,
        [threadId]: serverMessages,
      },
    };
    this.notify();
  }

  // ---- Selection setters ----

  setModel(model: AiProviderModel): void {
    this.state = { ...this.state, selectedModel: model };
    writeSelectedModel(this.state.locator, model);
    this.notify();
  }

  setDefaultModel(model: AiProviderModel | null, isLoading: boolean): void {
    // Only update if there's no valid stored model
    if (this.state.selectedModel) return;
    this.state = {
      ...this.state,
      selectedModel: model,
      isModelsLoading: isLoading,
    };
    this.notify();
  }

  setIsModelsLoading(loading: boolean): void {
    this.state = { ...this.state, isModelsLoading: loading };
    this.notify();
  }

  setAgent(agent: VirtualMCPInfo | null): void {
    this.state = { ...this.state, selectedAgent: agent };
    writeSelectedVirtualMcpId(this.state.locator, agent?.id ?? null);
    this.notify();
  }

  setMode(mode: ToolSelectionStrategy): void {
    this.state = { ...this.state, selectedMode: mode };
    writeSelectedMode(this.state.locator, mode);
    this.notify();
  }

  setCredentialId(id: string | null): void {
    this.state = { ...this.state, credentialId: id };
    writeSelectedKeyId(this.state.locator, id);
    this.notify();
  }

  setVirtualMcps(virtualMcps: VirtualMCPInfo[]): void {
    let selectedAgent = this.state.selectedAgent;

    // Resolve pending virtual MCP id from localStorage
    if (this._pendingVirtualMcpId) {
      selectedAgent =
        virtualMcps.find((v) => v.id === this._pendingVirtualMcpId) ?? null;
      this._pendingVirtualMcpId = null;
    }

    this.state = { ...this.state, virtualMcps, selectedAgent };
    this.notify();
  }

  setAllModelsConnections(
    connections: ReturnType<typeof useAiProviderKeyList>,
  ): void {
    this.state = { ...this.state, allModelsConnections: connections };
    this.notify();
  }

  setAppContext(sourceId: string, params: SetAppContextParams): void {
    const textParts: string[] = [];
    for (const block of params.content ?? []) {
      if (block.type === "text" && block.text?.trim()) {
        textParts.push(block.text.trim());
      }
    }
    const text = textParts.join("\n");

    if (!text) {
      this.clearAppContext(sourceId);
      return;
    }

    if (new TextEncoder().encode(text).length > MAX_APP_CONTEXT_LENGTH) return;
    if (
      Object.keys(this.state.appContexts).length >= MAX_APP_CONTEXT_SOURCES &&
      !(sourceId in this.state.appContexts)
    )
      return;

    this.state = {
      ...this.state,
      appContexts: { ...this.state.appContexts, [sourceId]: text },
    };
    // Don't notify — appContexts is only read at sendMessage time
  }

  clearAppContext(sourceId: string): void {
    const { [sourceId]: _, ...rest } = this.state.appContexts;
    this.state = { ...this.state, appContexts: rest };
  }

  setTiptapDoc(doc: Metadata["tiptapDoc"]): void {
    this.state = { ...this.state, tiptapDoc: doc };
    // Don't notify — tiptapDoc is written by ChatInput and only read at sendMessage time
  }

  clearFinishReason(): void {
    this.state = { ...this.state, finishReason: null };
    this.notify();
  }

  // ---- Chat operations ----

  async sendMessage(params: SendMessageParams): Promise<void> {
    const model = params.model ?? this.state.selectedModel;
    if (!model) {
      toast.error("No model configured");
      return;
    }

    // Derive parts
    const parts = params.parts ?? derivePartsFromTiptapDoc(params.tiptapDoc);
    if (parts.length === 0) return;

    // Thread switching
    const targetThread = params.threadId ?? this.state.activeThreadId;
    if (targetThread !== this.state.activeThreadId) {
      this.setActiveThread(targetThread);
    }

    // Apply overrides
    if (params.model) this.setModel(params.model);
    if (params.agent !== undefined) this.setAgent(params.agent);
    if (params.mode) this.setMode(params.mode);

    // Sync server-sourced messages into useAIChat before sending
    const existingMessages =
      this.state.threadMessages[this.state.activeThreadId] ?? [];
    if (existingMessages.length > 0) {
      this.chatBridge?.setMessages(existingMessages);
    }

    // Reset interaction
    this.state = { ...this.state, finishReason: null, tiptapDoc: undefined };
    this.notify();

    const decopilotId = getWellKnownDecopilotVirtualMCP(this.state.org.id).id;
    const selectedAgent = this.state.selectedAgent;
    const selectedMode = this.state.selectedMode;
    const effectiveKeyId = this.state.credentialId;

    const messageMetadata: Metadata = {
      tiptapDoc: params.tiptapDoc,
      created_at: new Date().toISOString(),
      thread_id: this.state.activeThreadId,
      agent: {
        id: selectedAgent?.id ?? decopilotId,
        mode: selectedMode,
      },
      user: {
        avatar: this.state.user?.image ?? undefined,
        name: this.state.user?.name ?? "you",
      },
    };

    // Compose system prompt: route context + app contexts
    const appContextEntries = Object.entries(this.state.appContexts);
    const appContextSection =
      appContextEntries.length > 0
        ? appContextEntries
            .map(([source, text]) => `### App Context: ${source}\n${text}`)
            .join("\n\n")
        : "";
    const system = [this.contextPrompt, appContextSection]
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

    await this.chatBridge?.sendMessage(userMessage, { metadata });
  }

  async cancelRun(): Promise<void> {
    const threadId = this.state.activeThreadId;
    if (!threadId) return;

    // Snapshot streaming messages into the task cache BEFORE stopping
    const bridgeMessages = this.state.threadMessages[threadId] ?? [];
    if (bridgeMessages.length > 0) {
      this.updateMessagesCacheFn?.(threadId, bridgeMessages);
    }

    this.chatBridge?.stop();

    try {
      const res = await fetch(
        `/api/${this.state.org.slug}/decopilot/cancel/${threadId}`,
        { method: "POST", credentials: "include" },
      );
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
  }

  stop(): void {
    if (this.state.status !== "ready") {
      void this.cancelRun();
    }
    this.chatBridge?.stop();
  }

  // ---- Streaming bridge (called by ChatBridge component) ----

  registerChatBridge(bridge: ChatBridgeMethods): void {
    this.chatBridge = bridge;
  }

  onStreamMessages(messages: ChatMessage[]): void {
    this.state = {
      ...this.state,
      threadMessages: {
        ...this.state.threadMessages,
        [this.state.activeThreadId]: messages,
      },
    };
    this.notify();
  }

  onStatusChange(status: "ready" | "submitted" | "streaming" | "error"): void {
    if (this.state.status === status) return;
    this.state = { ...this.state, status };
    this.notify();
  }

  onFinish(payload: FinishPayload): void {
    this.state = {
      ...this.state,
      status: "ready",
      finishReason: payload.finishReason ?? null,
    };

    const serverThreadId = (payload.message.metadata as Metadata | undefined)
      ?.thread_id;
    const threadId = serverThreadId ?? this.state.activeThreadId;

    // Sync server-assigned thread ID
    if (serverThreadId && serverThreadId !== this.state.activeThreadId) {
      const msgs = this.state.threadMessages[this.state.activeThreadId] ?? [];
      const { [this.state.activeThreadId]: _, ...rest } =
        this.state.threadMessages;
      this.state = {
        ...this.state,
        threadMessages: { ...rest, [serverThreadId]: msgs },
        activeThreadId: serverThreadId,
      };
      writeActiveThreadId(this.state.locator, serverThreadId);

      // Persist messages under the new server thread ID so ThreadListSync
      // doesn't wipe them with empty task manager data.
      if (msgs.length > 0) {
        this.updateMessagesCacheFn?.(serverThreadId, msgs);
      }
    }

    if (payload.isAbort || payload.isDisconnect || payload.isError) {
      if (threadId && payload.messages.length > 0) {
        this.updateMessagesCacheFn?.(threadId, payload.messages);
      }
      this.notify();
      return;
    }

    // Always persist streamed messages into the task cache
    if (threadId && payload.messages.length > 0) {
      this.updateMessagesCacheFn?.(threadId, payload.messages);
    }

    // Show notification if enabled
    if (this.enableNotifications && this.showNotification) {
      this.showNotification({
        tag: `chat-${threadId}`,
        title: "Decopilot is waiting for your input at",
        body:
          this.state.threads.find((t) => t.id === threadId)?.title ??
          "New chat",
      });
    }

    this.notify();
  }

  onError(error: Error): void {
    this.state = { ...this.state, error };
    this.notify();
    console.error("[chat] Error", error);
  }

  clearError(): void {
    this.state = { ...this.state, error: null };
    this.notify();
  }

  // ---- Bridge pass-throughs (called by UI components) ----

  addToolOutput(
    ...args: Parameters<NonNullable<ChatBridgeMethods["addToolOutput"]>>
  ): void {
    this.chatBridge?.addToolOutput(...args);
  }

  addToolApprovalResponse(
    ...args: Parameters<
      NonNullable<ChatBridgeMethods["addToolApprovalResponse"]>
    >
  ): void {
    this.chatBridge?.addToolApprovalResponse(...args);
  }

  setMessages(messages: ChatMessage[]): void {
    this.chatBridge?.setMessages(messages);
  }

  resumeStream(): Promise<void> {
    return this.chatBridge?.resumeStream() ?? Promise.resolve();
  }

  // ---- Derived (getters) ----

  get isRunInProgress(): boolean {
    const thread = this.state.threads.find(
      (t) => t.id === this.state.activeThreadId,
    );
    return (
      (thread?.status === "in_progress" || thread?.status === "expired") &&
      this.state.status === "ready"
    );
  }

  get isStreaming(): boolean {
    return (
      this.state.status === "submitted" || this.state.status === "streaming"
    );
  }

  get isChatEmpty(): boolean {
    const messages = this.state.threadMessages[this.state.activeThreadId] ?? [];
    return messages.length === 0;
  }

  get isWaitingForApprovals(): boolean {
    const messages = this.state.threadMessages[this.state.activeThreadId] ?? [];
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return false;
    return last.parts.some(
      (part) => "state" in part && part.state === "approval-requested",
    );
  }

  get activeMessages(): ChatMessage[] {
    return this.state.threadMessages[this.state.activeThreadId] ?? [];
  }

  getTransport(): DefaultChatTransport<UIMessage<Metadata>> {
    const orgSlug = this.state.org.slug;
    const store = this;
    return new DefaultChatTransport<UIMessage<Metadata>>({
      api: `/api/${orgSlug}/decopilot/stream`,
      credentials: "include",
      prepareReconnectToStreamRequest: ({ id }) => ({
        api: `/api/${store.state.org.slug}/decopilot/attach/${id}`,
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
            ...(store.toolApprovalLevel && {
              toolApprovalLevel: store.toolApprovalLevel,
            }),
          },
        };
      },
    });
  }
}

// ============================================================================
// Singleton
// ============================================================================

export const chatStore = new ChatStore();

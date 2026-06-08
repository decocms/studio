/**
 * Memory
 *
 * Thread-based conversation history management.
 * Wraps the thread storage for conversation-focused operations.
 */

import type { OrgScopedThreadStorage } from "@/storage/threads";
import type { Thread, ThreadMessage } from "@/storage/types";

/**
 * Configuration for creating a Memory instance
 */
export interface MemoryConfig {
  /** Thread ID (required — thread must exist) */
  thread_id: string;

  /** Organization scope */
  organization_id: string;

  /** User who owns/created the thread */
  userId: string;

  /** Default window size for pruning */
  defaultWindowSize?: number;
}

/**
 * Thread-based conversation memory.
 *
 * Provides:
 * - Thread management (get or create)
 * - Message history loading
 * - Message saving
 * - Pruning for context window management
 */
export class Memory {
  readonly thread: Thread;
  readonly organization_id: string;

  private storage: OrgScopedThreadStorage;
  private defaultWindowSize: number;

  constructor(config: {
    thread: Thread;
    storage: OrgScopedThreadStorage;
    defaultWindowSize?: number;
  }) {
    this.thread = config.thread;
    this.organization_id = config.thread.organization_id;
    this.storage = config.storage;
    this.defaultWindowSize = config.defaultWindowSize ?? 50;
  }

  async loadHistory(windowSize?: number): Promise<ThreadMessage[]> {
    const limit = windowSize ?? this.defaultWindowSize;

    // Read-path fork: v2 threads fold the stream-of-record `thread_message_parts`
    // (one place, one branch); v1 threads keep reading whole-message rows from
    // `thread_messages`. Both produce a chronological `ThreadMessage[]` plus an
    // `isWindowed` flag, then share the identical windowing/synthetic-prefix
    // formatting below. The org predicate (R23) is preserved either way: the
    // thread was already fetched org-scoped in `createMemory`, so `this.thread`
    // — and the id we pass to the part storage — belongs to the bound org.
    const { chronological, isWindowed } =
      this.thread.message_storage_version === 2
        ? await this.loadWindowedFromParts(limit)
        : await this.loadWindowedFromMessages(limit);

    // Stored system messages (welcome / tool injections) sit at the head of
    // some threads. Anthropic's requirement is that the first *non-system*
    // message is a user message — so the guard must look past leading
    // system rows before deciding whether to prepend the synthetic prefix.
    const firstNonSystem = chronological.find((m) => m.role !== "system");
    if (!firstNonSystem || firstNonSystem.role === "user") {
      return chronological;
    }
    const first = firstNonSystem;
    // Providers like Anthropic require the first non-system message to be
    // from "user". When the window leads with an assistant message — either
    // because the thread genuinely opens with one (welcome threads) or because
    // older user turns fell outside the window — prepend a synthetic user
    // note so the API accepts the conversation and the model has context for
    // why the assistant spoke first.
    const text = isWindowed
      ? "[Context: earlier turns in this conversation were truncated. The messages below continue the thread — pick up from there.]"
      : "[Context: this thread opens with your message — you spoke first to greet the user, and the user has not spoken before it. Their reply follows.]";
    const synthetic: ThreadMessage = {
      id: `${this.thread.id}-msg-prefix`,
      thread_id: this.thread.id,
      role: "user",
      parts: [{ type: "text", text }],
      metadata: undefined,
      created_at: first.created_at,
      updated_at: first.updated_at,
    };
    return [synthetic, ...chronological];
  }

  /**
   * v1 read path — newest `limit` whole-message rows from `thread_messages`,
   * reversed to chronological order. `isWindowed` is true when the thread has
   * more messages than the window returned (older turns were truncated).
   */
  private async loadWindowedFromMessages(
    limit: number,
  ): Promise<{ chronological: ThreadMessage[]; isWindowed: boolean }> {
    const { messages, total } = await this.storage.listMessages(
      this.thread.id,
      {
        limit,
        sort: "desc",
      },
    );
    return {
      chronological: [...messages].reverse(),
      isWindowed: total > messages.length,
    };
  }

  /**
   * v2 read path — fold the newest `limit` completed messages out of the
   * stream-of-record `thread_message_parts`. `loadWindow` already pages over
   * the per-message `finish` anchors (newest first) and folds chronologically,
   * so we adapt each `FoldedMessage` to the `ThreadMessage` shape the rest of
   * the pipeline expects. `isWindowed` mirrors the v1 semantics: more completed
   * messages exist than the window returned.
   */
  private async loadWindowedFromParts(
    limit: number,
  ): Promise<{ chronological: ThreadMessage[]; isWindowed: boolean }> {
    const { messages, total } = await this.storage
      .messageParts()
      .loadWindow(this.thread.id, { limit });
    const chronological: ThreadMessage[] = messages.map((m) => ({
      id: m.id,
      thread_id: this.thread.id,
      role: m.role,
      parts: m.parts as ThreadMessage["parts"],
      metadata: undefined,
      created_at: m.created_at,
      updated_at: m.created_at,
    }));
    return {
      chronological,
      isWindowed: total > messages.length,
    };
  }

  async save(messages: ThreadMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.storage.saveMessages(messages);
  }
}

/**
 * Get an existing thread by id, returning a Memory instance.
 * Throws if the thread does not exist — the route loader is responsible for
 * creating threads up-front via COLLECTION_THREADS_CREATE.
 */
export async function createMemory(
  storage: OrgScopedThreadStorage,
  config: MemoryConfig,
): Promise<Memory> {
  const { thread_id, defaultWindowSize } = config;

  if (!thread_id) {
    throw new Error("createMemory: thread_id is required");
  }

  const thread = await storage.get(thread_id);
  if (!thread) {
    throw new Error(`Thread not found: ${thread_id}`);
  }

  return new Memory({
    thread,
    storage,
    defaultWindowSize,
  });
}

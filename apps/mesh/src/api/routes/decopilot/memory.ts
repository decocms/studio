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
    const { messages } = await this.storage.listMessages(this.thread.id, {
      limit,
      sort: "desc",
    });
    // Reverse so chronological (oldest first)
    const chronological = [...messages].reverse();
    // Ensure the window starts with a "user" message; trim from the start if needed.
    // When no user message exists in the window, keep the windowed messages to preserve
    // assistant/tool context for follow-up turns.
    const startIndex = chronological.findIndex((m) => m.role === "user");
    return startIndex >= 0 ? chronological.slice(startIndex) : chronological;
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

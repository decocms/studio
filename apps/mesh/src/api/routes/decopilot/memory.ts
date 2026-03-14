/**
 * Memory
 *
 * Thread-based conversation history management.
 * Wraps the thread storage for conversation-focused operations.
 */

import type { OrgScopedThreadStorage } from "@/storage/threads";
import type { Thread, ThreadMessage } from "@/storage/types";
import { generatePrefixedId } from "@/shared/utils/generate-id";

/**
 * Configuration for creating a Memory instance
 */
export interface MemoryConfig {
  /** Thread ID (creates new if not found) */
  thread_id?: string | null;

  /** Organization scope */
  organization_id: string;

  /** User who owns/created the thread */
  userId: string;

  /** Default window size for pruning */
  defaultWindowSize?: number;

  /** Optional trigger ID for automation-created threads */
  triggerId?: string;
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
 * Create or get a thread, returning a Memory instance
 */
export async function createMemory(
  storage: OrgScopedThreadStorage,
  config: MemoryConfig,
): Promise<Memory> {
  const { thread_id, organization_id, userId, defaultWindowSize, triggerId } =
    config;

  let thread: Thread;

  if (!thread_id) {
    // Create new thread
    thread = await storage.create({
      id: generatePrefixedId("thrd"),
      organization_id,
      created_by: userId,
      trigger_id: triggerId ?? null,
    });
  } else {
    // Try to get existing thread scoped to this org
    const existing = await storage.get(thread_id);

    if (existing) {
      thread = existing;
    } else {
      // Thread not found — create using the client-provided ID so the
      // frontend and server stay in sync (avoids a thread-ID switch in
      // onFinish which causes a full re-render cascade).
      thread = await storage.create({
        id: thread_id,
        organization_id,
        created_by: userId,
        trigger_id: triggerId ?? null,
      });
    }
  }

  return new Memory({
    thread,
    storage,
    defaultWindowSize,
  });
}

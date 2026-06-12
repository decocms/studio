/**
 * Decopilot Conversation Processing
 *
 * Handles message processing, memory loading, and conversation state management.
 */

import type { ChatMessage } from "./types";
import type { Memory } from "./memory";
import type { ThreadMessage } from "@/storage/types";
export {
  denyPendingApprovals,
  processConversation,
} from "@decocms/harness/decopilot/conversation";
export type { ProcessedConversation } from "@decocms/harness/decopilot/conversation";

/**
 * Split request messages into system and the single request message.
 * Schema guarantees exactly one non-system message.
 */
export function splitRequestMessages(messages: ChatMessage[]): {
  systemMessages: ChatMessage[];
  requestMessage: ChatMessage;
} {
  const systemMessages = messages.filter((m) => m.role === "system");
  const requestMessage = messages.find((m) => m.role !== "system")!;
  return { systemMessages, requestMessage };
}

async function loadMemory(memory: Memory, windowSize: number) {
  const threadMessages = await memory.loadHistory(windowSize);
  return threadMessages;
}

function mergeMessages(
  threadMessages: ThreadMessage[],
  requestMessage?: ChatMessage,
): ChatMessage[] {
  // Filter out messages with empty parts to prevent bricked threads
  // (e.g. assistant messages saved after an LLM error before any content was generated)
  const validMessages = threadMessages.filter(
    (m) => m.parts && m.parts.length > 0,
  );
  if (!requestMessage) {
    return validMessages as ChatMessage[];
  }
  const matchIndex = validMessages.findIndex((m) => m.id === requestMessage.id);
  const conversation =
    matchIndex >= 0
      ? [...validMessages.slice(0, matchIndex), requestMessage]
      : [...validMessages, requestMessage];
  return conversation;
}

export async function loadAndMergeMessages(
  memory: Memory,
  requestMessage: ChatMessage | undefined,
  systemMessages: ChatMessage[],
  windowSize: number,
): Promise<ChatMessage[]> {
  const threadMessages = await loadMemory(memory, windowSize);
  const conversation = mergeMessages(threadMessages, requestMessage);
  const allMessages: ChatMessage[] = [...systemMessages, ...conversation];
  return allMessages;
}

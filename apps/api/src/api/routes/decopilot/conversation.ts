/**
 * Decopilot Conversation Processing
 *
 * Handles message processing, memory loading, and conversation state management.
 */

import type { ChatMessage } from "./types";
export {
  denyPendingApprovals,
  processConversation,
} from "@/harnesses/lib/decopilot/conversation";
export type { ProcessedConversation } from "@/harnesses/lib/decopilot/conversation";

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

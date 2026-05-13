/**
 * Decopilot Conversation Processing
 *
 * Handles message processing, memory loading, and conversation state management.
 */

import type { ModelsConfig } from "./types";
import {
  convertToModelMessages,
  ModelMessage,
  pruneMessages,
  SystemModelMessage,
  type ToolSet,
  validateUIMessages,
} from "ai";
import type { ChatMessage } from "./types";
import type { Memory } from "./memory";
import { ThreadMessage } from "@/storage/types";
import { readCurrentTodos, stripTodoWriteParts } from "./todo-write-context";
import type { Todo } from "./built-in-tools/todo-write";

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

export interface ProcessedConversation {
  systemMessages: SystemModelMessage[];
  messages: ReturnType<typeof pruneMessages>;
  /**
   * The current todo list, read from the pre-strip ModelMessage stream.
   * Exposed so `stream-core` can inject the `<current-todos>` system
   * tail without re-traversing the messages. Empty list if no
   * `todo_write` call has been made yet.
   */
  currentTodos: Todo[];
  originalMessages: ChatMessage[];
}

export function denyPendingApprovals(messages: ChatMessage[]): ChatMessage[] {
  let patched = false;
  const result = messages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    const hasPending = msg.parts.some(
      (part) => "state" in part && part.state === "approval-requested",
    );
    if (!hasPending) return msg;

    patched = true;
    return {
      ...msg,
      parts: msg.parts.map((part) => {
        if (
          !("state" in part) ||
          part.state !== "approval-requested" ||
          !("approval" in part) ||
          !part.approval
        ) {
          return part;
        }
        return {
          ...part,
          state: "output-denied",
          approval: {
            ...part.approval,
            approved: false as const,
            reason: "User sent a new message without approving this tool call.",
          },
        };
      }),
    } as ChatMessage;
  });

  return patched ? result : messages;
}

function splitMessages(messages: ModelMessage[]): {
  systemMessages: Extract<ModelMessage, { role: "system" }>[];
  messages: Extract<ModelMessage, { role: "user" | "assistant" | "tool" }>[];
} {
  const [system, nonSystem] = messages.reduce(
    (acc, m) => {
      if (m.role === "system") acc[0].push(m);
      else acc[1].push(m);
      return acc;
    },
    [[], []] as [
      Extract<ModelMessage, { role: "system" }>[],
      Extract<ModelMessage, { role: "user" | "assistant" | "tool" }>[],
    ],
  );
  return {
    systemMessages: system,
    messages: nonSystem,
  };
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
/**
 * Process messages for the conversation (memory is created externally)
 */
export async function processConversation(
  allMessages: ChatMessage[],
  config: { windowSize: number; models: ModelsConfig; tools?: ToolSet },
): Promise<ProcessedConversation> {
  // Filter out messages with empty parts before validation.
  // Assistant messages saved after an LLM error (e.g. Gemini returning empty)
  // have parts: [] which makes validateUIMessages throw "Message must contain
  // at least one part", bricking the entire thread.
  const sanitizedMessages = allMessages.filter(
    (m) => m.role !== "assistant" || (m.parts && m.parts.length > 0),
  );

  const validUIMessages = await validateUIMessages<ChatMessage>({
    messages: sanitizedMessages,
  });

  const patchedUIMessages = denyPendingApprovals(validUIMessages);

  const modelMessages = await convertToModelMessages(patchedUIMessages, {
    tools: config.tools,
    ignoreIncompleteToolCalls: true,
  });

  const {
    systemMessages: systemModelMessages,
    messages: nonSystemModelMessages,
  } = splitMessages(modelMessages);

  // Snapshot the live todo list from the pre-strip ModelMessage stream
  // so the caller can rebuild <current-todos> without redoing the scan.
  const currentTodos = readCurrentTodos(nonSystemModelMessages);

  // Strip todo_write tool-call/result parts. The current todo list is
  // derived from the original (pre-strip) UIMessage stream upstream and
  // re-injected as a <current-todos> system tail (see stream-core +
  // system-prompt). Older todo_write inputs are pure redundancy — the
  // state is encoded in the injected block, and the message-stream
  // representation never benefited from Anthropic prompt caching (no
  // cacheControl on messages).
  const todoStrippedMessages = stripTodoWriteParts(nonSystemModelMessages);

  // Strip reasoning from all previous assistant messages.
  // pruneMessages removes reasoning content parts, but leaves message-level
  // and part-level providerOptions/providerMetadata intact. The AI SDK's
  // Anthropic provider reconstructs thinking blocks from that metadata
  // (including cryptographic signatures). When OpenRouter load-balances
  // across backends (Anthropic direct, Azure, GCP), stale signatures from
  // one backend cause "Invalid signature in thinking block" on another.
  // We strip both reasoning parts AND all provider metadata from assistant
  // messages to prevent this.
  const prunedModelMessages = pruneMessages({
    messages: todoStrippedMessages,
    reasoning: "all",
    emptyMessages: "remove",
    toolCalls: "none",
  });

  const cleanedModelMessages = prunedModelMessages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    const content = Array.isArray(msg.content)
      ? msg.content
          .filter(
            (part: { type: string }) =>
              part.type !== "reasoning" &&
              part.type !== "thinking" &&
              part.type !== "redacted-reasoning",
          )
          .map((part) => {
            const p = part as Record<string, unknown>;
            if ("providerOptions" in p || "providerMetadata" in p) {
              const {
                providerOptions: _po,
                providerMetadata: _pm,
                ...rest
              } = p;
              // Don't strip Google's providerOptions from tool-call parts:
              // it carries thoughtSignature which Gemini needs on subsequent
              // turns when thinking is enabled.
              if (p.type === "tool-call") {
                const googleMeta = (_pm as Record<string, unknown>)?.google;
                const googleOpts = (_po as Record<string, unknown>)?.google;
                return {
                  ...rest,
                  ...(googleMeta
                    ? { providerMetadata: { google: googleMeta } }
                    : {}),
                  ...(googleOpts
                    ? { providerOptions: { google: googleOpts } }
                    : {}),
                } as typeof part;
              }
              return rest as typeof part;
            }
            return part;
          })
      : msg.content;

    return {
      ...msg,
      content:
        Array.isArray(content) && content.length === 0
          ? [{ type: "text" as const, text: "" }]
          : content,
      providerOptions: undefined,
      providerMetadata: undefined,
    } as typeof msg;
  });

  return {
    systemMessages: systemModelMessages,
    messages: cleanedModelMessages,
    currentTodos,
    originalMessages: validUIMessages,
  };
}

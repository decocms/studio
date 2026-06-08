/**
 * local-conversation — lean port of the PURE functions in
 * `api/routes/decopilot/conversation.ts`.
 *
 * Copies `processConversation`, `denyPendingApprovals`, and `splitMessages`.
 * Drops the cluster `Memory` / `ThreadMessage` VALUE paths (loadMemory,
 * mergeMessages, loadAndMergeMessages) — the desktop already has the full
 * message array in `HarnessStreamInput.messages`, so there's no DB load.
 *
 * The only type imports are `import type` (`ModelsConfig` from the cluster
 * decopilot types, `ChatMessage` = AI SDK `UIMessage`) — types erase at
 * compile time and never pull a runtime module into the bundle. The behaviour
 * (validate → deny-pending → convertToModelMessages with the real tool set →
 * split system → keep-last-todo → prune reasoning/metadata) is byte-for-byte
 * identical to the cluster path so prior-turn tool outputs transform the same
 * way (the three desktop tools with `toModelOutput` rely on this).
 */

import {
  convertToModelMessages,
  type ModelMessage,
  pruneMessages,
  type SystemModelMessage,
  type ToolSet,
  type UIMessage,
  validateUIMessages,
} from "ai";
import type { ModelsConfig } from "../types";
import { keepLastTodoWrite } from "../../api/routes/decopilot/todo-write-context";

type ChatMessage = UIMessage;

export interface ProcessedConversation {
  systemMessages: SystemModelMessage[];
  messages: ReturnType<typeof pruneMessages>;
  originalMessages: ChatMessage[];
}

/**
 * Convert any still-pending tool approvals into denials. When the user sends a
 * new message without approving a prior tool call, the call is marked denied so
 * the conversation can proceed. Copy of `conversation.ts:denyPendingApprovals`.
 */
function denyPendingApprovals(messages: ChatMessage[]): ChatMessage[] {
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

/**
 * Process the full message array for the conversation. Copy of
 * `conversation.ts:processConversation` (memory is supplied externally — the
 * desktop already has every message).
 */
export async function processConversation(
  allMessages: ChatMessage[],
  config: { windowSize: number; models: ModelsConfig; tools?: ToolSet },
): Promise<ProcessedConversation> {
  // Filter out empty-parts assistant messages before validation; an
  // empty-parts assistant message (LLM error before content) bricks
  // `validateUIMessages`.
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

  // Keep only the most recent `todo_write` tool-call/result pair.
  const todoTrimmedMessages = keepLastTodoWrite(nonSystemModelMessages);

  // Strip reasoning + provider metadata from prior assistant messages to avoid
  // "Invalid signature in thinking block" across load-balanced backends.
  const prunedModelMessages = pruneMessages({
    messages: todoTrimmedMessages,
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
              // Keep Google's thoughtSignature on tool-call parts (Gemini needs
              // it on subsequent turns when thinking is enabled).
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
    originalMessages: validUIMessages,
  };
}

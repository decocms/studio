import {
  convertToModelMessages,
  type ModelMessage,
  pruneMessages,
  type SystemModelMessage,
  type ToolSet,
  type UIMessage,
  validateUIMessages,
} from "ai";
import { keepLastTodoWrite } from "./todo-write-context";

export interface ProcessedConversation<TMessage extends UIMessage = UIMessage> {
  systemMessages: SystemModelMessage[];
  messages: ReturnType<typeof pruneMessages>;
  originalMessages: TMessage[];
}

export function denyPendingApprovals<TMessage extends UIMessage>(
  messages: TMessage[],
): TMessage[] {
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
    } as TMessage;
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

export async function processConversation<TMessage extends UIMessage>(
  allMessages: TMessage[],
  config: { windowSize: number; models: unknown; tools?: ToolSet },
): Promise<ProcessedConversation<TMessage>> {
  // Filter out messages with empty parts before validation. Assistant messages
  // saved after an LLM error can otherwise brick the entire thread.
  const sanitizedMessages = allMessages.filter(
    (m) => m.role !== "assistant" || (m.parts && m.parts.length > 0),
  );

  const validUIMessages = await validateUIMessages<TMessage>({
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
  // stale thinking signatures across load-balanced providers.
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
              // Keep Google's thoughtSignature on tool-call parts; Gemini
              // needs it on subsequent turns when thinking is enabled.
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

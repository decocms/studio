/**
 * `todo_write` context helpers.
 *
 * One ModelMessage-level operation used at HTTP-request entry
 * (cross-turn, via `processConversation`):
 *
 *   • `keepLastTodoWrite` — given a `ModelMessage[]`, keep only the
 *     most recent `todo_write` tool-call (by occurrence order) and
 *     its matching tool-result (by `toolCallId`); remove every older
 *     `todo_write` call/result. Non-`todo_write` parts are left
 *     untouched. Empty messages produced by stripping are left as
 *     `content: []` and cleaned up downstream by `pruneMessages`.
 *
 * The intra-loop strip+inject is gone: the agent sees its own
 * `todo_write` tool calls live inside the agent loop. Across turns,
 * historical `todo_write` calls are pruned to keep the context lean.
 *
 * The frontend chip's UIMessage reader lives separately in
 * `web/components/chat/highlight/derive-current-todos.ts` because the
 * UI part shape (`type: "tool-todo_write"`) differs from the model
 * part shape (`type: "tool-call", toolName: "todo_write"`). It is
 * unaffected by this module.
 */

import type { ModelMessage } from "ai";

const TODO_WRITE_TOOL_NAME = "todo_write";

interface PartLike {
  type?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
}

function isTodoWriteCallPart(part: PartLike): part is PartLike & {
  type: "tool-call";
  toolCallId: string;
} {
  return (
    part.type === "tool-call" &&
    part.toolName === TODO_WRITE_TOOL_NAME &&
    typeof part.toolCallId === "string"
  );
}

function isTodoWriteResultPart(part: PartLike): part is PartLike & {
  type: "tool-result";
  toolCallId: string;
} {
  return (
    part.type === "tool-result" &&
    part.toolName === TODO_WRITE_TOOL_NAME &&
    typeof part.toolCallId === "string"
  );
}

export function keepLastTodoWrite(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  // Pass 1: find the toolCallId of the latest todo_write tool-call.
  let latestCallId: string | null = null;
  for (let i = messages.length - 1; i >= 0 && latestCallId === null; i--) {
    const msg = messages[i]!;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j] as PartLike;
      if (isTodoWriteCallPart(part)) {
        latestCallId = part.toolCallId;
        break;
      }
    }
  }

  if (latestCallId === null) {
    // Nothing to do — no todo_write calls exist.
    return messages as ModelMessage[];
  }

  const survivorId = latestCallId;
  return messages.map((msg) => {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) return msg;

    const filtered = (content as PartLike[]).filter((part) => {
      if (isTodoWriteCallPart(part)) return part.toolCallId === survivorId;
      if (isTodoWriteResultPart(part)) return part.toolCallId === survivorId;
      return true;
    });

    if (filtered.length === content.length) return msg;
    return { ...msg, content: filtered } as ModelMessage;
  });
}

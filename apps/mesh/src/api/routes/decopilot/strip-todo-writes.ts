/**
 * stripTodoWriteParts — remove every `todo_write` tool-call and matching
 * tool-result part from a `ModelMessage[]`, returning a new array.
 *
 * The full todo list state is derived elsewhere (see `getCurrentTodos`
 * + the `<current-todos>` system tail in `system-prompt.ts`). Once the
 * state is injected as a non-cached system block, the per-call inputs
 * in the message stream are pure redundancy.
 *
 * Anthropic enforces balanced tool-call ↔ tool-result pairing; this
 * stripper removes both halves keyed by `toolName`. As a defensive
 * measure it also strips orphan tool-results whose `toolName` is
 * `todo_write` even if the matching call isn't visible — an orphan
 * result alone would also fail validation.
 *
 * Empty messages produced by stripping (e.g. an assistant message
 * whose only content was the call) are left as `content: []` and
 * cleaned up downstream by `pruneMessages({ emptyMessages: "remove" })`.
 */

import type { ModelMessage } from "ai";

const TODO_WRITE_TOOL_NAME = "todo_write";

interface PartLike {
  type?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
}

export function stripTodoWriteParts(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  return messages.map((msg) => {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) return msg;

    const filtered = (content as PartLike[]).filter((part) => {
      const isTodoWriteCall =
        part.type === "tool-call" && part.toolName === TODO_WRITE_TOOL_NAME;
      const isTodoWriteResult =
        part.type === "tool-result" && part.toolName === TODO_WRITE_TOOL_NAME;
      return !isTodoWriteCall && !isTodoWriteResult;
    });

    if (filtered.length === content.length) return msg;
    return { ...msg, content: filtered } as ModelMessage;
  });
}

/**
 * `todo_write` context helpers.
 *
 * Two ModelMessage-level operations used both at HTTP-request entry
 * (cross-turn, via `processConversation`) and inside the agent loop
 * (intra-loop, via `prepareStep`):
 *
 *   • `stripTodoWriteParts` — remove every `todo_write` tool-call and
 *     matching tool-result part from a `ModelMessage[]`, returning a
 *     new array. Empty messages produced by stripping are left as
 *     `content: []` and cleaned up downstream by `pruneMessages`.
 *
 *   • `readCurrentTodos` — scan a `ModelMessage[]` backwards for the
 *     most recent assistant `tool-call` with `toolName: "todo_write"`
 *     and return its parsed todo list. Malformed latest inputs fall
 *     through to older valid calls. Used to rebuild `<current-todos>`
 *     each agent-loop step from the pre-strip stream.
 *
 * Single source of truth: do not add another implementation. The
 * frontend chip's UIMessage reader lives separately in
 * `web/components/chat/highlight/derive-current-todos.ts` because the
 * UI part shape (`type: "tool-todo_write"`) differs from the model
 * part shape (`type: "tool-call", toolName: "todo_write"`).
 */

import type { ModelMessage } from "ai";
import { type Todo, TodoWriteInputSchema } from "./built-in-tools/todo-write";

const TODO_WRITE_TOOL_NAME = "todo_write";

interface PartLike {
  type?: unknown;
  toolName?: unknown;
  input?: unknown;
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

export function readCurrentTodos(messages: readonly ModelMessage[]): Todo[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j] as PartLike;
      if (part.type !== "tool-call") continue;
      if (part.toolName !== TODO_WRITE_TOOL_NAME) continue;
      const parsed = TodoWriteInputSchema.safeParse(part.input);
      if (parsed.success) return parsed.data.todos;
      // Latest call had malformed input; fall through to older calls.
    }
  }
  return [];
}

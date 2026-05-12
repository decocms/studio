/**
 * getCurrentTodos — read the current todo list for a thread by scanning
 * its message history backwards for the most recent `todo_write` tool
 * call. The latest valid call wins.
 *
 * Source-of-truth note: there is no `thread_todos` table. The list is
 * derived from the message stream. Callers must pass the same window
 * the chat is using; todos older than the loaded window are invisible
 * (acceptable first-cut limitation — see spec).
 */

import type { UIMessage } from "ai";
import { type Todo, TodoWriteInputSchema } from "./built-in-tools/todo-write";

interface UnknownPart {
  type?: unknown;
  state?: unknown;
  input?: unknown;
}

const TODO_WRITE_PART_TYPE = "tool-todo_write";
const READABLE_STATES = new Set(["input-available", "output-available"]);

export function getCurrentTodos(messages: readonly UIMessage[]): Todo[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const parts = (m as { parts?: UnknownPart[] }).parts;
    if (!Array.isArray(parts)) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]!;
      if (part.type !== TODO_WRITE_PART_TYPE) continue;
      if (typeof part.state !== "string" || !READABLE_STATES.has(part.state)) {
        continue;
      }
      const parsed = TodoWriteInputSchema.safeParse(part.input);
      if (parsed.success) return parsed.data.todos;
      // Latest call had malformed input; fall through to older calls.
    }
  }
  return [];
}

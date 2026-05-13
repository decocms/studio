/**
 * `deriveCurrentTodos` — frontend reader for the chat highlight chip.
 *
 * Scans the live `UIMessage[]` rendered in the chat for the most recent
 * `todo_write` tool-part and returns its parsed todo list. UIMessages
 * carry todo_write as `type: "tool-todo_write"` with a `state` field;
 * we only trust `input-available` and `output-available` states so we
 * never read mid-stream partial input.
 *
 * This is the UI-shape twin of the backend's
 * `readCurrentTodos(ModelMessage[])` in
 * `api/routes/decopilot/todo-write-context.ts`. They cannot share an
 * implementation because the part shapes differ.
 */

import type { UIMessage } from "ai";
import {
  type Todo,
  TodoWriteInputSchema,
} from "@/api/routes/decopilot/built-in-tools/todo-write";

interface UnknownPart {
  type?: unknown;
  state?: unknown;
  input?: unknown;
}

const TODO_WRITE_PART_TYPE = "tool-todo_write";
const READABLE_STATES = new Set(["input-available", "output-available"]);

export function deriveCurrentTodos(messages: readonly UIMessage[]): Todo[] {
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

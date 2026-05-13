/**
 * todo_write Built-in Tool
 *
 * Claude-Code-style TodoWrite: the model rewrites the full todo list on
 * every call. There is no incremental create/update/delete. The list's
 * source of truth is the most recent todo_write tool-call message in the
 * thread; see `todo-write-context.ts` for the reader (`readCurrentTodos`).
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";

export const TodoItemSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe("Imperative form, e.g. 'Implement the login flow'"),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z
    .string()
    .min(1)
    .describe(
      "Present-continuous form shown in the UI while the todo is in progress, e.g. 'Implementing the login flow'",
    ),
});

export type Todo = z.infer<typeof TodoItemSchema>;

export const TodoWriteInputSchema = z.object({
  todos: z.array(TodoItemSchema),
});

export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

const description =
  "Plan and track multi-step work. Call with the FULL todo list every time — this replaces the prior list. " +
  "Use whenever a task has 3+ distinct steps. Mark exactly one todo `in_progress` at a time. " +
  "Flip a todo to `in_progress` before starting it and to `completed` the moment it finishes — do not batch completions. " +
  "For trivial (<3 step) work, do not call this tool at all. " +
  "The current list is always visible to you in the `<current-todos>` system block — do not call this tool to read the list back.";

export const todoWriteTool = tool({
  description,
  inputSchema: zodSchema(TodoWriteInputSchema),
  execute: async ({ todos }: TodoWriteInput) => ({
    ok: true as const,
    count: todos.length,
  }),
});

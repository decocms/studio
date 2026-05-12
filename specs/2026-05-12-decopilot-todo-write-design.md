---
title: Decopilot `todo_write` — Design
status: ready-for-implementation
date: 2026-05-12
owner: tlgimenes
related:
  - 2026-05-12-decopilot-context-compactification-research.md (parked — depends on PR #3337)
---

# Decopilot `todo_write` — Design

## Summary

A Claude-Code-style TodoWrite tool for decopilot. The model maintains a per-thread, ephemeral list of todos by repeatedly calling a single `todo_write` tool that replaces the whole list. A sidebar panel in the chat UI renders the current list; tool calls themselves render with the standard tool-call UI in the chat stream.

## Goals

- Give the model a structured planning surface for multi-step work (3+ steps).
- Make in-progress work visible to the user without cluttering the chat.
- Ship without new database tables or sync logic.

## Non-goals

- Cross-thread or cross-project persistence.
- User-editable todos.
- Subtask dispatch (the existing `subtask` built-in tool covers that).
- Priorities, due dates, IDs, hierarchies.
- Any interaction with the parked compactification module — `todo_write` calls are small enough to need no special elision.

## Background

Decopilot's built-in tools live in `apps/mesh/src/api/routes/decopilot/built-in-tools/` and are registered in `index.ts` via `buildAllTools`. Conventions:

- Tool names are lowercase snake_case (`user_ask`, `web_search`, `propose_plan`).
- Stateless tools are exported as constants (e.g. `userAskTool`); tools with deps use factory functions.
- All built-ins flow through `instrumentBuiltIns` for posthog `tool_called` analytics.
- Annotations in `BUILTIN_TOOL_ANNOTATIONS` mirror MCP annotation semantics (`readOnly`, `destructive`).

Claude Code's TodoWrite, the reference implementation we're copying:
- Single tool, takes the full todo array on every call. No incremental ops.
- Schema: `{ content, status: pending|in_progress|completed, activeForm }`. No IDs — array position is identity.
- Exactly one todo may be `in_progress` at a time (system-prompted, not schema-enforced).
- Used for tasks with 3+ steps; skipped for trivial work.

## Design

### Tool surface

**Name:** `todo_write`

**AI SDK `tool()` definition:**

```ts
import { tool } from "ai";
import { z } from "zod";

const TodoItemSchema = z.object({
  content: z.string().min(1).describe(
    "Imperative form, e.g. 'Implement the login flow'"
  ),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().min(1).describe(
    "Present-continuous form shown in the spinner, e.g. 'Implementing the login flow'"
  ),
});

export const TodoWriteInputSchema = z.object({
  todos: z.array(TodoItemSchema),
});

export const todoWriteTool = tool({
  description: "Plan and track multi-step work. Call with the FULL list every time — this replaces the prior list. Use for any task with 3+ steps. Mark exactly one todo in_progress at a time.",
  inputSchema: TodoWriteInputSchema,
  execute: async ({ todos }) => ({ ok: true as const, count: todos.length }),
});

export type Todo = z.infer<typeof TodoItemSchema>;
```

The tool's `execute` is intentionally trivial — the value is the persisted tool-call message itself, not the return.

**Annotation:** `todo_write: { readOnly: false, destructive: false }` in `BUILTIN_TOOL_ANNOTATIONS` (`built-in-tools/index.ts:16`).

**Registration:** unconditional, alongside `user_ask` (no provider, model, or env gating).

### Storage

**Source of truth: the thread message stream.** Each `todo_write` invocation is a normal AI SDK tool-call message persisted in `thread_messages` by the existing flow. No new tables. No `threads.todos` column.

**Reading current todos:** scan the recent message window (already loaded by `apps/mesh/src/api/routes/decopilot/memory.ts`) for the most recent `todo_write` tool-call part. Its `input.todos` is the current state. Absent → empty list.

A shared helper covers server + client:

```ts
// apps/mesh/src/api/routes/decopilot/current-todos.ts
import type { UIMessage } from "ai";
import { TodoWriteInputSchema, type Todo } from "./built-in-tools/todo-write";

export function getCurrentTodos(messages: UIMessage[]): Todo[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const part = m.parts[j];
      if (
        part.type === "tool-todo_write" &&
        (part.state === "input-available" || part.state === "output-available")
      ) {
        const parsed = TodoWriteInputSchema.safeParse(part.input);
        if (parsed.success) return parsed.data.todos;
      }
    }
  }
  return [];
}
```

(Exact `part.type` / state strings to be confirmed against the AI SDK version in `package.json` during implementation — the AI SDK has gone through several tool-part-type shapes.)

### System prompt

The system-prompt parts are assembled in `apps/mesh/src/api/routes/decopilot/stream-core.ts:724` (`systemPrompts: string[]`). The decopilot identity block comes from `buildDecopilotAgentPrompt()` in `apps/mesh/src/api/routes/decopilot/constants.ts`. `system-prompt.ts` is just the cache-marker wrapper.

`todo_write` is a built-in tool available to **all** agents (decopilot + custom agents), so its guidance should travel with the tool, not with the decopilot identity. Add a new `buildTodoWritePrompt()` (in `constants.ts` alongside the other prompt builders) and slot it into the `systemPrompts` array in `stream-core.ts`, between `connectionsBlock` and `agentPrompt` so the agent-specific instructions get the final word.

Block content:

> ## todo_write
>
> You have a `todo_write` tool for planning and tracking multi-step work.
>
> - Use it whenever a task has 3+ distinct steps.
> - Mark exactly one todo `in_progress` at any time.
> - Update the list as you work: flip a todo to `in_progress` before starting it, `completed` the moment it finishes. Don't batch completions.
> - Rewrite the entire list every call — there is no incremental update.
> - For trivial (<3 step) work, skip the list entirely.
> - `content` is imperative ("Implement X"); `activeForm` is present-continuous ("Implementing X") and shown in the user's UI while the task is in progress.

### Frontend

**Naming caveat:** an org-wide `TasksPanelColumn` already exists at `apps/mesh/src/web/layouts/agent-shell-layout/tasks-panel-column.tsx` for organization-level automations. This is a different concept — our new feature is per-thread, model-managed, and uses the term **todos**. Component names: `TodosPanel`, `TodosColumn` (or similar) — never "Tasks".

**Sidebar panel** rendered alongside the chat. Reads `getCurrentTodos(messages)` from the same message stream the chat already has. No new API endpoint.

The chat layout entry point is `apps/mesh/src/web/layouts/agent-shell-layout/chat-main-panel-group.tsx`. The new `TodosColumn` lives as a sibling component there.

Empty state: render nothing (column collapses) when no todos exist. The column appears the moment the model first calls `todo_write`.

In-progress todo gets a spinner using `activeForm`. Completed todos visually de-emphasized (strike-through + reduced opacity). Pending todos plain.

**No user interaction** — read-only.

**Chat stream:** `todo_write` calls render with the existing default tool-call UI. No custom inline component. The sidebar carries the "current state" story; the chat stream carries the audit story.

### Files touched / added

**Added:**
- `apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.ts` — `todoWriteTool`, `TodoWriteInputSchema`, `Todo` type.
- `apps/mesh/src/api/routes/decopilot/current-todos.ts` — `getCurrentTodos` helper.
- Frontend: `apps/mesh/src/web/components/chat/todos-panel.tsx` (panel body) + a column wrapper next to the `TasksPanelColumn` in the layout.
- Tests: `todo-write.test.ts`, `current-todos.test.ts`.

**Edited:**
- `apps/mesh/src/api/routes/decopilot/built-in-tools/index.ts` — register `todo_write` in `buildAllTools`; add to `BUILTIN_TOOL_ANNOTATIONS`.
- `apps/mesh/src/api/routes/decopilot/built-in-tools/registration.test.ts` — assert `todo_write` is in the registered tool set.
- `apps/mesh/src/api/routes/decopilot/constants.ts` — add `buildTodoWritePrompt()`.
- `apps/mesh/src/api/routes/decopilot/stream-core.ts` — slot `buildTodoWritePrompt()` into the `systemPrompts` array.
- `apps/mesh/src/web/layouts/agent-shell-layout/chat-main-panel-group.tsx` — mount the new `TodosColumn`.

## Testing strategy

- **Tool schema:** valid/invalid `todo_write` inputs (missing `activeForm`, wrong `status` enum, empty `content`).
- **Tool execute:** returns `{ ok: true, count }` matching input length.
- **`getCurrentTodos`:** returns latest list across multiple `todo_write` calls; returns `[]` when no call present; ignores non-`todo_write` tool calls.
- **Registration:** `todo_write` appears in `getBuiltInTools` output unconditionally; appears regardless of `isPlanMode`, `provider`, or env vars.
- **Posthog instrumentation:** `tool_called` event fires with `tool_source: "builtin"`, `tool_name: "todo_write"`.
- **System prompt:** the assembled system prompt contains the `todo_write` guidance.
- **Frontend (visual):** sidebar renders three states correctly (empty, mid-task with one in_progress, all completed).

## Open items for the implementation plan

- Confirm the exact AI SDK tool-part shape (`type: "tool-todo_write"` vs `type: "tool-call", toolName: "todo_write"`) against the version in `package.json`. The reader helper depends on this.
- Locate the chat layout component in `apps/mesh/src/web/` and slot in the sidebar panel.
- Decide the sidebar panel's collapsed/expanded behavior on small viewports.
- Decide whether the same panel should be hidden when zero todos exist or render an empty state.

## Out of scope (revisited)

- Compactification (parked — see related spec).
- Cross-thread persistence.
- User edits.
- Hierarchy, subtasks, priorities, dates.

---
title: Decopilot `todo_write` Context Optimization — Strip Stale Calls, Inject Current State
status: ready-for-implementation
date: 2026-05-12
owner: tlgimenes
follows:
  - 2026-05-12-decopilot-todo-write-design.md
  - 2026-05-12-decopilot-todo-write-implementation.md
related-issues:
  - https://github.com/decocms/studio/issues/3345 (parked context compactification)
---

# Decopilot `todo_write` Context Optimization

## Summary

The newly-shipped `todo_write` tool sends the full todo list as input on every call. With repeated revisions, the AI SDK message window accumulates N redundant copies of the list — each call's `input.todos` plus its tool result. Today's pipeline keeps all of them (`processConversation` passes `pruneMessages` with `toolCalls: "none"`).

This spec replaces that redundancy with a single derived-state injection: **strip all `todo_write` tool-call/result parts from the message stream, and inject the current list as a non-cached `<current-todos>` block in the system message tail.**

Net effect: ~O(N) redundant token cost collapses to O(1). No cache invalidation. Same model behavior. Closer to how Claude Code handles its internal TodoWrite.

## Goals

- Eliminate redundant `todo_write` history in the LLM context.
- Inject the current list at a stable, prominent position so the model can always reference it.
- Preserve Anthropic prompt cache hits — no cached block may be invalidated.
- Stay within the 3-of-4 Anthropic cache breakpoint budget.
- Behave identically for decopilot and `subtask` paths (both go through `processConversation`).

## Non-goals

- Cross-turn observation/summarization (covered by parked context compactification, issue #3345).
- Tool-result elision for other tools (e.g., `web_search`, `read_resource`) — separate, future-scope work.
- Persisting todo state outside the thread (still ephemeral per spec).
- User-editable todos.

## Background

### Today's pipeline

- `Memory.loadHistory(50)` (`apps/mesh/src/api/routes/decopilot/memory.ts`) loads the last 50 messages verbatim.
- `processConversation` (`apps/mesh/src/api/routes/decopilot/conversation.ts:174-179`) calls `pruneMessages({ toolCalls: "none" })` — **all tool calls survive**, including every historical `todo_write` revision.
- The full window is fed to `streamText`.

### Today's cache layout

Three Anthropic cache breakpoints, none on messages:

| Position | Breakpoint | Source |
|---|---|---|
| Last alphabetical tool | BP1 | `cache-instrumentation.ts:54-75` (`withCachedToolPrefix`) |
| `system[N-2]` | BP2 | `system-prompt.ts:69-89` (`buildSystemMessages`) |
| `system[N-1]` | BP3 | same |

`<current-context>` (date/time) sits as a non-cached system tail after BP3. Messages have no markers and are re-processed every turn.

### Why this matters

For a 10-item todo list (~600 tokens of `input.todos` JSON), with 5 revisions in the window, the model is fed ~3,000 tokens of stale list versions every turn. The prompt cache doesn't save us here — messages aren't cached. The only way to recover the tokens is to stop sending them.

## Design

### 1. Strip all `todo_write` parts from messages

In `processConversation`, after `convertToModelMessages` and before `pruneMessages`, run a stripping pass that removes:

- Every assistant message tool-call part with `type === "tool-todo_write"`.
- Every matching tool-result part for those calls (by `toolCallId`).
- Empty messages left behind after stripping (handled by `pruneMessages`'s existing `emptyMessages: "remove"` setting).

The stripper must handle the **balanced-pair invariant** that Anthropic enforces: a tool-call without its matching tool-result (or vice versa) causes a 400 error. The implementation strips calls and results together as a unit, keyed by `toolCallId`.

The stripper also runs on assistant messages whose ONLY content was a `todo_write` call — those messages become empty and `pruneMessages` removes them.

### 2. Extract the current state

Before stripping, run `getCurrentTodos(messages)` (already exists in `current-todos.ts` from the prior PR) to capture the latest valid todo list. Pass the result up to `stream-core.ts`.

If `getCurrentTodos` returns `[]` (no `todo_write` in window, OR the latest call had malformed input), no injection happens. The model proceeds as before.

### 3. Inject `<current-todos>` as a non-cached system tail

In `system-prompt.ts`, add a new builder alongside `buildCurrentContextPrompt`:

```ts
export function buildCurrentTodosPrompt(todos: Todo[]): string | null {
  if (todos.length === 0) return null;
  const lines = todos.map((t) => {
    const label = t.status === "in_progress" ? t.activeForm : t.content;
    return `- [${t.status}] ${label}`;
  });
  return `<current-todos>\n${lines.join("\n")}\n</current-todos>`;
}
```

Append it to the non-cached tail of `buildSystemMessages`, after `<current-context>`:

```
[
  ...cached system messages with BP2, BP3...,
  { role: "system", content: <current-context> },     // not cached (existing)
  { role: "system", content: <current-todos> },        // not cached (NEW)
]
```

When `buildCurrentTodosPrompt` returns `null`, no system message is appended.

### 4. Update the tool prompt and description

Tell the model that the current list is **always visible** in `<current-todos>`, so it never needs to call `todo_write` purely to "read back" the list — only to update it.

Edit `buildTodoWritePrompt()` in `constants.ts` to add:

> The current list is always visible to you in the `<current-todos>` system block. Do not call `todo_write` to read it back — call it only when you need to add, update, or complete a todo.

Edit the tool's `description` in `todo-write.ts` to add a single sentence reinforcing the same point.

### 5. Cache impact (re-confirmation)

| Block | Today | After change | Cache hit? |
|---|---|---|---|
| Tools prefix (BP1) | cached | byte-identical | ✅ |
| System through BP2 | cached | byte-identical | ✅ |
| System through BP3 | cached | byte-identical | ✅ |
| `<current-context>` tail | not cached | not cached | n/a |
| `<current-todos>` tail (new) | n/a | not cached | n/a |
| Messages | not cached | not cached, content changed | n/a |

Zero invalidation. Cache breakpoint budget: still 3/4. The proposal adds an unmarked system message; no new breakpoint consumed.

## AI SDK plumbing

### Where the stripper runs

`apps/mesh/src/api/routes/decopilot/conversation.ts:processConversation` is the chokepoint for both the parent decopilot loop and the `subtask` path (per the comment in `cache-instrumentation.ts`). The stripper goes there.

Current shape (paraphrased):
```ts
const modelMessages = convertToModelMessages(materializedMessages, ...);
const { systemMessages, messages: nonSystemModelMessages } = splitMessages(modelMessages);
const prunedModelMessages = pruneMessages({
  messages: nonSystemModelMessages,
  reasoning: "all",
  emptyMessages: "remove",
  toolCalls: "none",
});
```

New shape:
```ts
const modelMessages = convertToModelMessages(materializedMessages, ...);
const { systemMessages, messages: nonSystemModelMessages } = splitMessages(modelMessages);
const stripped = stripTodoWriteParts(nonSystemModelMessages);
const prunedModelMessages = pruneMessages({
  messages: stripped,
  reasoning: "all",
  emptyMessages: "remove",
  toolCalls: "none",
});
```

`processConversation` already returns `originalMessages` (un-stripped) for the title-generator path. That stays untouched — the stripping is only for the LLM-bound copy.

### How the current state reaches `system-prompt.ts`

`stream-core.ts` already computes `materializedMessages` before calling `processConversation`. Add one line:

```ts
const currentTodos = getCurrentTodos(materializedMessages);
```

Pass `currentTodos` into `buildSystemMessages` (or compute the new system message and append it where `buildCurrentContextPrompt` is appended today).

### Stripper semantics

Input shape after `convertToModelMessages`: `ModelMessage[]`. Each assistant message has `content: (TextPart | ReasoningPart | ToolCallPart)[]`. Each tool message has `content: ToolResultPart[]`. The stripper:

1. Collects all `toolCallId`s where the call has `toolName === "todo_write"`.
2. Walks each message's `content` array, removing matching tool-call and tool-result parts.
3. Returns the modified messages; `pruneMessages`'s `emptyMessages: "remove"` handles fully-emptied messages downstream.

The function is pure — same input always yields the same output. No external state.

## Files touched

**Added:**
- `apps/mesh/src/api/routes/decopilot/strip-todo-writes.ts` — `stripTodoWriteParts(messages: ModelMessage[]): ModelMessage[]`.
- `apps/mesh/src/api/routes/decopilot/strip-todo-writes.test.ts` — schema + edge cases.
- (Maybe) `apps/mesh/src/api/routes/decopilot/system-prompt.test.ts` is extended for the new `<current-todos>` tail — file may already exist; check first.

**Edited:**
- `apps/mesh/src/api/routes/decopilot/conversation.ts` — call `stripTodoWriteParts` before `pruneMessages`.
- `apps/mesh/src/api/routes/decopilot/system-prompt.ts` — add `buildCurrentTodosPrompt(todos)` (or similar inline construction) and extend `buildSystemMessages` to accept `todos` and append the new tail when non-empty.
- `apps/mesh/src/api/routes/decopilot/stream-core.ts` — compute `currentTodos = getCurrentTodos(materializedMessages)` and pass to `buildSystemMessages`.
- `apps/mesh/src/api/routes/decopilot/constants.ts` — extend `buildTodoWritePrompt()` with the "current list is always visible" note.
- `apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.ts` — extend `description` with the same note.
- Update affected tests: `constants.test.ts` (new prompt content), `system-prompt.test.ts` if it exists.

## Testing strategy

### `stripTodoWriteParts`

- Empty messages array → empty.
- No `todo_write` calls → identical output.
- Single call+result pair → both removed; if the parent assistant message had only the call as content, the message becomes empty (and is handled downstream).
- Multiple calls across multiple messages → all removed.
- Mixed tool calls (some `todo_write`, some `user_ask`) → only `todo_write` parts removed; `user_ask` parts and their results preserved.
- Orphan tool-result (call already stripped by an earlier pass, or call was missing) → result still stripped (defensive).
- Orphan tool-call (no matching result, e.g. mid-stream interrupted state) → call stripped to maintain balanced pairing on the *output*; downstream `pruneMessages` cleanup may or may not apply, but Anthropic won't see an orphan.

### `buildCurrentTodosPrompt` (new helper)

- Empty todos → returns `null`.
- Single pending todo → `<current-todos>\n- [pending] content\n</current-todos>`.
- In-progress todo → uses `activeForm` as the label.
- Completed + pending mix → renders all with correct status tags.
- Verify the block is not wrapped in cache markers (it must be appended to the non-cached tail).

### Integration test in `conversation.test.ts`

A conversation with two `todo_write` calls in sequence, plus a user message and a `user_ask` call:
- `originalMessages` returned to caller still contains all parts (for title gen + audit).
- The `messages` returned to the LLM has zero `tool-todo_write` parts (calls and results), but retains the `user_ask` parts.

### End-to-end smoke (manual, Task 7-style)

- Send a multi-step task that triggers 3+ `todo_write` calls.
- Inspect a server-side log of the assembled `streamText` request (or use the existing usage-metadata test hooks).
- Confirm: zero `tool-todo_write` parts in messages, one `<current-todos>` block in system messages, list matches the sidebar.

## Open questions / decisions deferred

- **Should the model still see `todo_write` *results*?** Decision: no. The model gets the current state from `<current-todos>`; the result `{ ok, count }` carries no extra info.
- **Should the stripper run on `subtask` agents?** Yes — same `processConversation` chokepoint. A subagent invoked via the `subtask` tool inherits the same context-shape contract.
- **Does the sidebar UI still work?** Yes — `getCurrentTodos` is called against the *original* (pre-strip) message stream client-side. The strip only affects what reaches the LLM.
- **Anthropic vs. OpenAI vs. Gemini behavior:** the AI SDK's `convertToModelMessages` produces provider-neutral `ModelMessage` shapes; the stripper operates on those before any provider serialization. All three providers receive the same stripped payload.

## Out of scope

- Stripping tool-call parts for other tools (e.g. elide stale `read_resource` outputs). The general case is the parked compactification work; this spec is `todo_write`-specific because its full-list-replacement semantics make the stripping behaviorally lossless.
- Cross-thread persistence of todos.
- Vector retrieval / observation logs.
- Adding a 4th Anthropic cache breakpoint on the messages prefix (would be a separate, larger change that benefits from this work landing first).

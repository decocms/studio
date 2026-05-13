# Decopilot `todo_write` Context Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip every `todo_write` tool-call/result part from the LLM-bound message stream and inject the current todo list as a `<current-todos>` block in the non-cached system tail — turning O(N) redundant tokens into O(1) without invalidating any cache breakpoint.

**Architecture:** Pure stripping function (`stripTodoWriteParts`) runs inside `processConversation` after `convertToModelMessages` and before `pruneMessages`. Current state is captured in `stream-core.ts` via the already-existing `getCurrentTodos` helper (on the pre-strip UIMessage stream), then passed through `buildSystemMessages` to be appended as a new non-cached system tail alongside `<current-context>`. Tool description and `buildTodoWritePrompt` are updated to tell the model the current list is always visible.

**Tech Stack:** TypeScript, Bun test runner, AI SDK v6 (`ai` ^6.0.116) — `ModelMessage`, `convertToModelMessages`, `pruneMessages` — Zod (for the schema already shipped with `todo_write`).

**Reference spec:** `specs/2026-05-12-decopilot-todo-write-context-optimization-design.md`.

---

## Task 1 — `stripTodoWriteParts` helper

**Files:**
- Create: `apps/mesh/src/api/routes/decopilot/strip-todo-writes.ts`
- Test: `apps/mesh/src/api/routes/decopilot/strip-todo-writes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/api/routes/decopilot/strip-todo-writes.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { stripTodoWriteParts } from "./strip-todo-writes";

function assistantWithToolCalls(
  calls: Array<{ toolCallId: string; toolName: string; input?: unknown }>,
): ModelMessage {
  return {
    role: "assistant",
    content: calls.map((c) => ({
      type: "tool-call" as const,
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input ?? {},
    })),
  } as ModelMessage;
}

function toolResults(
  results: Array<{ toolCallId: string; toolName: string; output?: unknown }>,
): ModelMessage {
  return {
    role: "tool",
    content: results.map((r) => ({
      type: "tool-result" as const,
      toolCallId: r.toolCallId,
      toolName: r.toolName,
      output: r.output ?? { type: "json", value: { ok: true } },
    })),
  } as ModelMessage;
}

describe("stripTodoWriteParts", () => {
  test("returns empty array unchanged", () => {
    expect(stripTodoWriteParts([])).toEqual([]);
  });

  test("returns unchanged when no todo_write calls", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" } as ModelMessage,
      assistantWithToolCalls([
        { toolCallId: "a", toolName: "user_ask", input: { prompt: "?" } },
      ]),
      toolResults([{ toolCallId: "a", toolName: "user_ask" }]),
    ];
    expect(stripTodoWriteParts(messages)).toEqual(messages);
  });

  test("removes a todo_write call and its matching result", () => {
    const messages: ModelMessage[] = [
      assistantWithToolCalls([
        {
          toolCallId: "tw1",
          toolName: "todo_write",
          input: { todos: [{ content: "x", status: "pending", activeForm: "doing x" }] },
        },
      ]),
      toolResults([
        { toolCallId: "tw1", toolName: "todo_write", output: { type: "json", value: { ok: true, count: 1 } } },
      ]),
    ];
    const result = stripTodoWriteParts(messages);
    // Tool-call assistant message had only the todo_write call; now empty content.
    expect(result[0]).toMatchObject({ role: "assistant", content: [] });
    // Tool message had only the todo_write result; now empty content.
    expect(result[1]).toMatchObject({ role: "tool", content: [] });
  });

  test("removes todo_write parts while preserving other tool calls in the same message", () => {
    const messages: ModelMessage[] = [
      assistantWithToolCalls([
        { toolCallId: "ua", toolName: "user_ask", input: { prompt: "?" } },
        {
          toolCallId: "tw1",
          toolName: "todo_write",
          input: { todos: [{ content: "x", status: "pending", activeForm: "doing x" }] },
        },
      ]),
      toolResults([
        { toolCallId: "ua", toolName: "user_ask" },
        { toolCallId: "tw1", toolName: "todo_write" },
      ]),
    ];
    const result = stripTodoWriteParts(messages);
    const assistantContent = (result[0] as { content: unknown[] }).content;
    expect(assistantContent).toHaveLength(1);
    expect(assistantContent[0]).toMatchObject({ toolName: "user_ask" });

    const toolContent = (result[1] as { content: unknown[] }).content;
    expect(toolContent).toHaveLength(1);
    expect(toolContent[0]).toMatchObject({ toolName: "user_ask" });
  });

  test("strips multiple todo_write revisions across multiple messages", () => {
    const messages: ModelMessage[] = [
      assistantWithToolCalls([
        { toolCallId: "tw1", toolName: "todo_write" },
      ]),
      toolResults([{ toolCallId: "tw1", toolName: "todo_write" }]),
      { role: "user", content: "next" } as ModelMessage,
      assistantWithToolCalls([
        { toolCallId: "tw2", toolName: "todo_write" },
      ]),
      toolResults([{ toolCallId: "tw2", toolName: "todo_write" }]),
    ];
    const result = stripTodoWriteParts(messages);
    // Assistant messages emptied
    expect((result[0] as { content: unknown[] }).content).toHaveLength(0);
    expect((result[3] as { content: unknown[] }).content).toHaveLength(0);
    // Tool messages emptied
    expect((result[1] as { content: unknown[] }).content).toHaveLength(0);
    expect((result[4] as { content: unknown[] }).content).toHaveLength(0);
    // User message preserved
    expect(result[2]).toMatchObject({ role: "user", content: "next" });
  });

  test("strips an orphan todo_write tool-result (defensive)", () => {
    // Tool-result whose call wasn't visible in this window — strip the result
    // alone to avoid leaving an unpaired tool-result that Anthropic rejects.
    const messages: ModelMessage[] = [
      toolResults([{ toolCallId: "tw_orphan", toolName: "todo_write" }]),
    ];
    expect((stripTodoWriteParts(messages)[0] as { content: unknown[] }).content)
      .toHaveLength(0);
  });

  test("preserves text parts on assistant messages while stripping tool-call", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text" as const, text: "ok, here's the plan:" },
          {
            type: "tool-call" as const,
            toolCallId: "tw1",
            toolName: "todo_write",
            input: { todos: [] },
          },
        ],
      } as ModelMessage,
      toolResults([{ toolCallId: "tw1", toolName: "todo_write" }]),
    ];
    const result = stripTodoWriteParts(messages);
    const assistantContent = (result[0] as { content: unknown[] }).content;
    expect(assistantContent).toHaveLength(1);
    expect(assistantContent[0]).toMatchObject({ type: "text", text: "ok, here's the plan:" });
  });

  test("returns a new array — does not mutate input", () => {
    const original: ModelMessage[] = [
      assistantWithToolCalls([
        { toolCallId: "tw1", toolName: "todo_write" },
      ]),
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    stripTodoWriteParts(original);
    expect(original).toEqual(snapshot);
  });

  test("ignores non-array string content (user messages)", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" } as ModelMessage,
    ];
    expect(stripTodoWriteParts(messages)).toEqual(messages);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/api/routes/decopilot/strip-todo-writes.test.ts`
Expected: FAIL with "Cannot find module './strip-todo-writes'".

- [ ] **Step 3: Implement the stripper**

Create `apps/mesh/src/api/routes/decopilot/strip-todo-writes.ts`:

```ts
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
 * stripper removes both halves keyed by `toolCallId`. As a defensive
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/api/routes/decopilot/strip-todo-writes.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/strip-todo-writes.ts apps/mesh/src/api/routes/decopilot/strip-todo-writes.test.ts
git commit -m "feat(decopilot): add stripTodoWriteParts helper

Pure function that removes todo_write tool-call and tool-result parts
from a ModelMessage[] by toolName. Defensive: strips orphan results
too. Returns a new array; inputs are not mutated. The full todo list
state is derived elsewhere and re-injected as a system message tail
(follow-up commits)."
```

---

## Task 2 — Wire `stripTodoWriteParts` into `processConversation`

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/conversation.ts`
- Modify: `apps/mesh/src/api/routes/decopilot/conversation.test.ts`

- [ ] **Step 1: Add an integration-shaped failing test**

Open `apps/mesh/src/api/routes/decopilot/conversation.test.ts` and append a new `describe` block (do not modify existing tests):

```ts
describe("processConversation — todo_write stripping", () => {
  test("strips todo_write tool-call/result parts from LLM messages but keeps them in originalMessages", async () => {
    const messages: ChatMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "make a plan" }],
      } as unknown as ChatMessage,
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-todo_write",
            state: "output-available",
            toolCallId: "tw1",
            input: {
              todos: [
                { content: "step 1", status: "pending", activeForm: "doing step 1" },
              ],
            },
            output: { ok: true, count: 1 },
          },
        ],
      } as unknown as ChatMessage,
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "go" }],
      } as unknown as ChatMessage,
    ];

    const result = await processConversation(messages, {
      windowSize: 50,
      models: { connectionId: "c", thinking: { id: "m" } } as never,
    });

    // The LLM-bound `messages` must not contain any todo_write parts.
    const allParts = result.messages.flatMap((m) =>
      Array.isArray((m as { content?: unknown }).content)
        ? ((m as { content: { type?: unknown; toolName?: unknown }[] }).content)
        : [],
    );
    const todoWriteParts = allParts.filter(
      (p) => p.toolName === "todo_write",
    );
    expect(todoWriteParts).toHaveLength(0);

    // The originalMessages preserve everything (used by title gen + audit).
    const originalAssistant = result.originalMessages.find((m) => m.id === "a1");
    expect(originalAssistant).toBeDefined();
    const originalHasTodoWrite = (originalAssistant!.parts as { type?: string }[]).some(
      (p) => p.type === "tool-todo_write",
    );
    expect(originalHasTodoWrite).toBe(true);
  });
});
```

If `conversation.test.ts` does not import `ChatMessage` or `processConversation` already, add the imports at the top:

```ts
import { processConversation } from "./conversation";
import type { ChatMessage } from "./types";
```

(Check the existing imports first; if both are present, don't duplicate.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/api/routes/decopilot/conversation.test.ts`
Expected: FAIL on the new `strips todo_write tool-call/result parts...` test.

- [ ] **Step 3: Wire the stripper into `processConversation`**

In `apps/mesh/src/api/routes/decopilot/conversation.ts`:

3a. Add the import at the top alongside the existing `./` imports:

```ts
import { stripTodoWriteParts } from "./strip-todo-writes";
```

3b. Find the `pruneMessages` call (around line 174). Apply the stripper to `nonSystemModelMessages` before passing to `pruneMessages`. The current block reads:

```ts
  const {
    systemMessages: systemModelMessages,
    messages: nonSystemModelMessages,
  } = splitMessages(modelMessages);

  // Strip reasoning from all previous assistant messages.
  // [...existing comment block...]
  const prunedModelMessages = pruneMessages({
    messages: nonSystemModelMessages,
    reasoning: "all",
    emptyMessages: "remove",
    toolCalls: "none",
  });
```

Change to:

```ts
  const {
    systemMessages: systemModelMessages,
    messages: nonSystemModelMessages,
  } = splitMessages(modelMessages);

  // Strip todo_write tool-call/result parts. The current todo list is
  // derived from the original (pre-strip) UIMessage stream upstream and
  // re-injected as a <current-todos> system tail (see stream-core +
  // system-prompt). Older todo_write inputs are pure redundancy — the
  // state is encoded in the injected block, and the message-stream
  // representation never benefited from Anthropic prompt caching (no
  // cacheControl on messages).
  const todoStrippedMessages = stripTodoWriteParts(nonSystemModelMessages);

  // Strip reasoning from all previous assistant messages.
  // [...existing comment block stays...]
  const prunedModelMessages = pruneMessages({
    messages: todoStrippedMessages,
    reasoning: "all",
    emptyMessages: "remove",
    toolCalls: "none",
  });
```

- [ ] **Step 4: Run tests to verify the integration test passes**

Run: `bun test apps/mesh/src/api/routes/decopilot/conversation.test.ts`
Expected: PASS, including the new `strips todo_write tool-call/result parts...` test, plus all existing tests in the file.

Run: `bun test apps/mesh/src/api/routes/decopilot/`
Expected: all PASS.

Run: `bun run --cwd=apps/mesh check`
Expected: clean.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/conversation.ts apps/mesh/src/api/routes/decopilot/conversation.test.ts
git commit -m "feat(decopilot): strip todo_write parts in processConversation

Apply stripTodoWriteParts to the LLM-bound message stream before
pruneMessages. originalMessages (used by title-gen and audit) keep the
parts intact — only the streamText input is cleaned. The current todo
list will be re-injected as a system tail in the next commit."
```

---

## Task 3 — `buildCurrentTodosPrompt` helper

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/system-prompt.ts`
- Modify: `apps/mesh/src/api/routes/decopilot/system-prompt.test.ts` (create if absent — check first)

- [ ] **Step 1: Write the failing test**

If `system-prompt.test.ts` exists, append the `describe` block below. Otherwise create the file at `apps/mesh/src/api/routes/decopilot/system-prompt.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildCurrentTodosPrompt } from "./system-prompt";
import type { Todo } from "./built-in-tools/todo-write";

describe("buildCurrentTodosPrompt", () => {
  test("returns null for empty todo list", () => {
    expect(buildCurrentTodosPrompt([])).toBeNull();
  });

  test("renders a single pending todo with content", () => {
    const todos: Todo[] = [
      { content: "Implement login", status: "pending", activeForm: "Implementing login" },
    ];
    const block = buildCurrentTodosPrompt(todos);
    expect(block).toContain("<current-todos>");
    expect(block).toContain("</current-todos>");
    expect(block).toContain("[pending] Implement login");
  });

  test("renders an in_progress todo with activeForm (not content)", () => {
    const todos: Todo[] = [
      { content: "Run tests", status: "in_progress", activeForm: "Running tests" },
    ];
    const block = buildCurrentTodosPrompt(todos);
    expect(block).toContain("[in_progress] Running tests");
    expect(block).not.toContain("Run tests");
  });

  test("renders completed todos with content (not activeForm)", () => {
    const todos: Todo[] = [
      { content: "Wrote docs", status: "completed", activeForm: "Writing docs" },
    ];
    const block = buildCurrentTodosPrompt(todos);
    expect(block).toContain("[completed] Wrote docs");
  });

  test("renders a full mixed list in order", () => {
    const todos: Todo[] = [
      { content: "Done item", status: "completed", activeForm: "Doing done" },
      { content: "Active item", status: "in_progress", activeForm: "Doing active" },
      { content: "Pending item", status: "pending", activeForm: "Doing pending" },
    ];
    const block = buildCurrentTodosPrompt(todos)!;
    const lines = block.split("\n");
    expect(lines).toEqual([
      "<current-todos>",
      "- [completed] Done item",
      "- [in_progress] Doing active",
      "- [pending] Pending item",
      "</current-todos>",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/api/routes/decopilot/system-prompt.test.ts`
Expected: FAIL with "buildCurrentTodosPrompt is not a function" or "Cannot find name".

- [ ] **Step 3: Implement `buildCurrentTodosPrompt`**

In `apps/mesh/src/api/routes/decopilot/system-prompt.ts`, after `buildCurrentContextPrompt` (around line 40-46), add:

```ts
import type { Todo } from "./built-in-tools/todo-write";

/**
 * Per-request, non-cached system prompt block carrying the current
 * todo list. Returns null when the list is empty so the caller can
 * skip the append entirely. Lives alongside <current-context> in the
 * non-cached system tail — never wrapped in cache markers.
 */
export function buildCurrentTodosPrompt(todos: readonly Todo[]): string | null {
  if (todos.length === 0) return null;
  const lines = todos.map((t) => {
    const label = t.status === "in_progress" ? t.activeForm : t.content;
    return `- [${t.status}] ${label}`;
  });
  return `<current-todos>\n${lines.join("\n")}\n</current-todos>`;
}
```

Place the `import type { Todo }` line with the other imports at the top of `system-prompt.ts` (currently just `import { EPHEMERAL_5M } from "./cache-instrumentation";`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/api/routes/decopilot/system-prompt.test.ts`
Expected: PASS (5 new tests, plus any existing tests in the file).

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/system-prompt.ts apps/mesh/src/api/routes/decopilot/system-prompt.test.ts
git commit -m "feat(decopilot): add buildCurrentTodosPrompt helper

Renders a Todo[] into a non-cached <current-todos> system block.
Returns null for empty lists so callers can skip the append entirely.
The block uses [status] prefixes and the activeForm label for
in_progress items so the model has a single canonical view of the
list state."
```

---

## Task 4 — Extend `buildSystemMessages` to append `<current-todos>`

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/system-prompt.ts`
- Modify: `apps/mesh/src/api/routes/decopilot/system-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/mesh/src/api/routes/decopilot/system-prompt.test.ts`:

```ts
import { buildSystemMessages } from "./system-prompt";

describe("buildSystemMessages — current todos tail", () => {
  const now = new Date("2026-05-12T10:00:00Z");

  test("appends no extra system message when todos is empty", () => {
    const out = buildSystemMessages(["base", "agent"], now, []);
    // 2 parts + 1 <current-context> tail = 3 messages
    expect(out).toHaveLength(3);
    // The last message is <current-context>, NOT <current-todos>.
    expect(out[2]!.content).toContain("<current-context>");
    expect(out[2]!.content).not.toContain("<current-todos>");
  });

  test("appends <current-todos> after <current-context> when todos non-empty", () => {
    const out = buildSystemMessages(
      ["base", "agent"],
      now,
      [{ content: "x", status: "pending", activeForm: "doing x" }],
    );
    // 2 parts + <current-context> + <current-todos> = 4 messages
    expect(out).toHaveLength(4);
    expect(out[2]!.content).toContain("<current-context>");
    expect(out[3]!.content).toContain("<current-todos>");
    expect(out[3]!.content).toContain("[pending] x");
  });

  test("the new <current-todos> tail message has NO cache markers", () => {
    const out = buildSystemMessages(
      ["base", "agent"],
      now,
      [{ content: "x", status: "pending", activeForm: "doing x" }],
    );
    expect(out[3]!.providerOptions).toBeUndefined();
  });

  test("cache markers on BP1/BP2 are unchanged when todos non-empty", () => {
    const out = buildSystemMessages(
      ["base", "agent"],
      now,
      [{ content: "x", status: "pending", activeForm: "doing x" }],
    );
    // parts.length === 2, so bp1Idx = 0, bp2Idx = 1 — both get markers.
    expect(out[0]!.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
    });
    expect(out[1]!.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
    });
    // <current-context> and <current-todos> tails both unmarked.
    expect(out[2]!.providerOptions).toBeUndefined();
    expect(out[3]!.providerOptions).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/api/routes/decopilot/system-prompt.test.ts`
Expected: FAIL on the new tests because `buildSystemMessages` does not yet accept a `todos` parameter.

- [ ] **Step 3: Extend `buildSystemMessages`**

In `apps/mesh/src/api/routes/decopilot/system-prompt.ts`, find `buildSystemMessages` (around line 69). The current signature is `buildSystemMessages(parts: string[], now: Date): SystemMessage[]`. Change to accept an optional `todos` parameter:

```ts
export function buildSystemMessages(
  parts: string[],
  now: Date,
  todos: readonly Todo[] = [],
): SystemMessage[] {
  const out: SystemMessage[] = [];
  const bp2Idx = parts.length - 1;
  const bp1Idx = parts.length - 2;
  for (let i = 0; i < parts.length; i++) {
    const isCacheCut = i === bp1Idx || i === bp2Idx;
    out.push({
      role: "system",
      content: parts[i]!,
      ...(isCacheCut ? { providerOptions: EPHEMERAL_5M_PROVIDER_OPTIONS } : {}),
    });
  }
  out.push({
    role: "system",
    content: buildCurrentContextPrompt(now),
  });
  const todosBlock = buildCurrentTodosPrompt(todos);
  if (todosBlock !== null) {
    out.push({
      role: "system",
      content: todosBlock,
    });
  }
  return out;
}
```

The default `todos = []` keeps the function backwards-compatible (existing callers that don't pass it get the same behavior as before plus the no-op skip in `buildCurrentTodosPrompt`).

- [ ] **Step 4: Run tests**

Run: `bun test apps/mesh/src/api/routes/decopilot/system-prompt.test.ts`
Expected: all PASS (the new tests plus any existing).

Run: `bun run --cwd=apps/mesh check`
Expected: clean (the default-empty `todos` parameter keeps all existing callers compatible).

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/system-prompt.ts apps/mesh/src/api/routes/decopilot/system-prompt.test.ts
git commit -m "feat(decopilot): append <current-todos> tail in buildSystemMessages

When the caller passes a non-empty todos array, append it as a
non-cached system message immediately after <current-context>. Empty
todos = no append (no behavioral change). Cache markers on BP1/BP2
are untouched."
```

---

## Task 5 — Wire `getCurrentTodos` + pass to `buildSystemMessages` in `stream-core`

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/stream-core.ts`

- [ ] **Step 1: Locate the call sites**

In `apps/mesh/src/api/routes/decopilot/stream-core.ts`:

- `materializedMessages` is computed around line 757 via `resolveStorageRefs(allMessages, ctx)`.
- `processConversation` is called immediately after (around line 763).
- `buildSystemMessages(systemPrompts, new Date())` is called around line 946.

- [ ] **Step 2: Add the import and compute `currentTodos`**

Add `getCurrentTodos` to the imports at the top of `stream-core.ts`. Find the existing import that pulls from `./current-todos` — there is no such import yet, so add:

```ts
import { getCurrentTodos } from "./current-todos";
```

Place it alongside the other relative imports (preserve alphabetical ordering of the import block if the file uses one).

Immediately after the line that computes `materializedMessages` (around line 757), add:

```ts
        // Capture the current todo list from the (pre-strip) UIMessage
        // stream. The matching strip happens inside processConversation;
        // we read here so the state survives stripping.
        const currentTodos = getCurrentTodos(materializedMessages);
```

- [ ] **Step 3: Pass `currentTodos` to `buildSystemMessages`**

Change the `buildSystemMessages` call (around line 946) from:

```ts
        const systemPromptMessages = buildSystemMessages(
          systemPrompts,
          new Date(),
        );
```

to:

```ts
        const systemPromptMessages = buildSystemMessages(
          systemPrompts,
          new Date(),
          currentTodos,
        );
```

- [ ] **Step 4: Run all decopilot tests**

Run: `bun test apps/mesh/src/api/routes/decopilot/`
Expected: all PASS.

Run: `bun run --cwd=apps/mesh check`
Expected: clean.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/stream-core.ts
git commit -m "feat(decopilot): inject <current-todos> into streamText system input

stream-core now reads the current todo list from the pre-strip
UIMessage stream and passes it through buildSystemMessages, which
appends a non-cached <current-todos> system message after
<current-context>. Empty lists produce no append (current default
behavior). The matching strip in processConversation ensures the
model sees one canonical view of the list."
```

---

## Task 6 — Update tool description and `buildTodoWritePrompt`

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.ts`
- Modify: `apps/mesh/src/api/routes/decopilot/constants.ts`
- Modify: `apps/mesh/src/api/routes/decopilot/constants.test.ts`
- Modify: `apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.test.ts`

- [ ] **Step 1: Write the failing tests**

In `apps/mesh/src/api/routes/decopilot/constants.test.ts`, append a test:

```ts
  test("tells the model the current list is always visible", () => {
    expect(buildTodoWritePrompt()).toMatch(
      /current[- ]?todos|always visible|always present in the system/i,
    );
  });
```

(Place it inside the existing `describe("buildTodoWritePrompt", ...)` block.)

In `apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.test.ts`, append a test:

```ts
  test("description tells the model not to call todo_write to read the list", () => {
    expect(todoWriteTool.description).toMatch(
      /current[- ]?todos|do not call.*to read|always visible/i,
    );
  });
```

(Place it inside the existing `describe("todoWriteTool", ...)` block.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/mesh/src/api/routes/decopilot/constants.test.ts apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.test.ts`
Expected: both new tests FAIL.

- [ ] **Step 3: Extend `buildTodoWritePrompt`**

In `apps/mesh/src/api/routes/decopilot/constants.ts`, find `buildTodoWritePrompt()` (added in a prior PR; around line 77+). The current body looks like:

```
<todo-write>
You have a `todo_write` tool for planning and tracking multi-step work.

- Use it whenever a task has 3+ distinct steps.
- Mark exactly one todo `in_progress` at any time.
- Update the list as you work: flip a todo to `in_progress` before
  starting it, `completed` the moment it finishes. Do not batch
  completions.
- Rewrite the entire list every call — there is no incremental update.
- For trivial (<3 step) work, do not call the tool at all.
- `content` is imperative ("Implement X"); `activeForm` is
  present-continuous ("Implementing X") and shown in the user's UI
  while the todo is in progress.
</todo-write>
```

Add one new bullet to the list (place it as the last bullet, before the closing `</todo-write>`):

```
- The current list is always visible to you in the `<current-todos>`
  system block. Do not call `todo_write` to read the list back — call
  it only to add, update, or complete a todo.
```

- [ ] **Step 4: Extend the tool `description` in `todo-write.ts`**

In `apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.ts`, find `const description = ...`. The current value ends with `"... For trivial (<3 step) work, do not call this tool at all."`. Append one sentence:

```ts
const description =
  "Plan and track multi-step work. Call with the FULL todo list every time — this replaces the prior list. " +
  "Use whenever a task has 3+ distinct steps. Mark exactly one todo `in_progress` at a time. " +
  "Flip a todo to `in_progress` before starting it and to `completed` the moment it finishes — do not batch completions. " +
  "For trivial (<3 step) work, do not call this tool at all. " +
  "The current list is always visible to you in the `<current-todos>` system block — do not call this tool to read the list back.";
```

- [ ] **Step 5: Run tests**

Run: `bun test apps/mesh/src/api/routes/decopilot/constants.test.ts apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.test.ts`
Expected: all PASS (including the 2 new tests).

Run: `bun test apps/mesh/src/api/routes/decopilot/`
Expected: all PASS.

Run: `bun run --cwd=apps/mesh check`
Expected: clean.

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/constants.ts apps/mesh/src/api/routes/decopilot/constants.test.ts apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.ts apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.test.ts
git commit -m "feat(decopilot): tell model the todo list is always visible

The model now sees the current list in <current-todos>. Update the
tool description and buildTodoWritePrompt so it doesn't waste a
todo_write call to read the list back."
```

---

## Task 7 — End-to-end manual smoke test

**Files:** none (manual verification)

- [ ] **Step 1: Run the dev environment**

```bash
bun run dev
```

- [ ] **Step 2: Trigger multiple `todo_write` calls**

Open decopilot and send: *"Plan a 5-step refactor and update the list as you 'finish' each one (just simulate completion). Use todo_write."*

The model should call `todo_write` ~5 times across the conversation.

- [ ] **Step 3: Inspect the assembled system prompt**

The most reliable way to verify is to look at the streamText request body. Two options:

(a) **Server-side log:** add a temporary `console.log("system", JSON.stringify(systemPromptMessages, null, 2))` immediately after `buildSystemMessages` is called in `stream-core.ts:946`, restart the server, send the message, and inspect the log. **Remove the log before any commit.**

(b) **Provider-side capture:** if you're running against a provider proxy (e.g. an OpenRouter dev endpoint) with request logging, capture the request body there.

Confirm: the system messages include a `<current-todos>` block matching the latest list rendered in the sidebar, with `[status]` prefixes and `activeForm` labels on `in_progress` items.

- [ ] **Step 4: Confirm `todo_write` is absent from messages**

In the same captured request, scan `messages` for any object with `toolName === "todo_write"`. Expected: zero matches.

- [ ] **Step 5: Confirm cache hit rate is unchanged**

Compare the `cacheReadTokens` reported in the response usage metadata (visible in PostHog `tool_called` events or in the response stream's `onFinish` callback) before vs after this change. Expected: similar or higher cache-read counts (cached system prefix is unchanged, smaller request body).

Look at the OTel traces if available, or the cache-instrumentation accumulator's logged values — see `apps/mesh/src/api/routes/decopilot/cache-instrumentation.ts:130-138` for the read/write counters.

- [ ] **Step 6: Sidebar still shows the correct list**

The `TodosColumn` reads from the *original* (pre-strip) UIMessage stream client-side via `getCurrentTodos`. Confirm: the sidebar continues to show the latest list, updating live as each `todo_write` streams in.

- [ ] **Step 7: Run the full test suite and commit any fixups**

```bash
bun test
bun run --cwd=apps/mesh check
bun run lint
bun run fmt:check
```

Expected: all green. If anything fails, fix and commit.

---

## Final check

- [ ] **Spec coverage:** every section of `specs/2026-05-12-decopilot-todo-write-context-optimization-design.md` is implemented:
  - Stripping helper (Task 1)
  - Wired into `processConversation` (Task 2)
  - `buildCurrentTodosPrompt` (Task 3)
  - `buildSystemMessages` extension (Task 4)
  - `getCurrentTodos` capture + pass-through in `stream-core` (Task 5)
  - Tool description + system-prompt guidance updates (Task 6)
  - Smoke test (Task 7)
- [ ] **Cache invariants verified:** No new `providerOptions.anthropic.cacheControl` markers added. Tool prefix BP unchanged. System BP1/BP2 unchanged.

- [ ] **Push the branch**

```bash
git push origin tlgimenes/decopilot-compact-thread
```

Since the existing PR (if any) already covers the prior `todo_write` work on this branch, push as a continuation. If you want a separate PR for the optimization, branch off `tlgimenes/decopilot-compact-thread` first.

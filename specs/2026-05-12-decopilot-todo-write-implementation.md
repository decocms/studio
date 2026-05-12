# Decopilot `todo_write` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude-Code-style `todo_write` built-in tool to decopilot — model rewrites the full todo list on every call, current state derives from the latest call in the message stream, and a sidebar panel renders the list in the chat UI.

**Architecture:** Single AI SDK `tool()` named `todo_write` with a trivial server-side `execute` (returns `{ ok, count }`). The tool-call message persisted in `thread_messages` is the source of truth; no new tables. A `getCurrentTodos(messages)` helper scans the message window backwards for the latest call. A new `TodosColumn` mounts alongside the existing `TasksPanelColumn` in the agent-shell layout. System-prompt guidance is appended via a new `buildTodoWritePrompt()` slotted into `systemPrompts` in `stream-core.ts`, available to all agents (decopilot + custom).

**Tech Stack:** TypeScript, Bun test runner, Zod, AI SDK v6 (`ai` ^6.0.116), React 19 + Tailwind v4, Hono server.

**Reference spec:** `specs/2026-05-12-decopilot-todo-write-design.md`.

---

## Task 1 — `todo_write` tool definition

**Files:**
- Create: `apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.ts`
- Test: `apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  todoWriteTool,
  TodoWriteInputSchema,
  type Todo,
} from "./todo-write";

describe("todoWriteTool", () => {
  test("has description, input schema, and execute", () => {
    expect(todoWriteTool.description).toContain("todo");
    expect(todoWriteTool.inputSchema).toBeDefined();
    expect(typeof todoWriteTool.execute).toBe("function");
  });

  test("accepts a well-formed todo list", () => {
    const input = {
      todos: [
        {
          content: "Implement login flow",
          status: "in_progress",
          activeForm: "Implementing login flow",
        },
        {
          content: "Write integration tests",
          status: "pending",
          activeForm: "Writing integration tests",
        },
      ] as Todo[],
    };
    expect(TodoWriteInputSchema.safeParse(input).success).toBe(true);
  });

  test("rejects todos with empty content", () => {
    const input = {
      todos: [{ content: "", status: "pending", activeForm: "Doing" }],
    };
    expect(TodoWriteInputSchema.safeParse(input).success).toBe(false);
  });

  test("rejects unknown status values", () => {
    const input = {
      todos: [
        { content: "x", status: "blocked", activeForm: "Doing x" },
      ],
    };
    expect(TodoWriteInputSchema.safeParse(input).success).toBe(false);
  });

  test("accepts an empty todo list (model is clearing it)", () => {
    expect(TodoWriteInputSchema.safeParse({ todos: [] }).success).toBe(true);
  });

  test("execute returns ok + count", async () => {
    const input = {
      todos: [
        { content: "a", status: "pending" as const, activeForm: "doing a" },
        { content: "b", status: "completed" as const, activeForm: "doing b" },
      ],
    };
    // AI SDK v6 tool().execute is invoked with (input, options) where
    // options has an abortSignal. We pass a minimal object.
    const result = await todoWriteTool.execute!(input, {
      toolCallId: "test",
      messages: [],
      abortSignal: new AbortController().signal,
    } as never);
    expect(result).toEqual({ ok: true, count: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.test.ts`
Expected: FAIL with "Cannot find module './todo-write'" (or similar — module doesn't exist yet).

- [ ] **Step 3: Implement the tool**

Create `apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.ts`:

```ts
/**
 * todo_write Built-in Tool
 *
 * Claude-Code-style TodoWrite: the model rewrites the full todo list on
 * every call. There is no incremental create/update/delete. The list's
 * source of truth is the most recent todo_write tool-call message in the
 * thread; see `current-todos.ts` for the reader.
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
  "For trivial (<3 step) work, do not call this tool at all.";

export const todoWriteTool = tool({
  description,
  inputSchema: zodSchema(TodoWriteInputSchema),
  execute: async ({ todos }: TodoWriteInput) =>
    ({ ok: true as const, count: todos.length }),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.ts apps/mesh/src/api/routes/decopilot/built-in-tools/todo-write.test.ts
git commit -m "feat(decopilot): add todo_write tool definition

Tool schema, types, and trivial server-side execute. Registration and
prompt wiring follow in subsequent commits."
```

---

## Task 2 — Register `todo_write` in built-in tools

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/built-in-tools/index.ts`
- Modify: `apps/mesh/src/api/routes/decopilot/built-in-tools/registration.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/mesh/src/api/routes/decopilot/built-in-tools/registration.test.ts` (inside the existing `describe("getBuiltInTools", ...)` block, after the existing tests):

```ts
  test("returns ToolSet with todo_write tool", async () => {
    const tools = await getTools();
    expect((tools as Record<string, unknown>).todo_write).toBeDefined();
  });

  test("todo_write tool has correct description", async () => {
    const tools = await getTools();
    const t = (tools as Record<string, { description: string }>).todo_write;
    expect(t.description).toContain("Plan and track multi-step work");
  });

  test("todo_write tool has execute function (server-side)", async () => {
    const tools = await getTools();
    const t = (tools as Record<string, { execute?: unknown }>).todo_write;
    expect(typeof t.execute).toBe("function");
  });

  test("todo_write is registered unconditionally (no provider needed)", async () => {
    // Re-run with provider: null (Claude Code branch); todo_write should still appear
    const tools = await getBuiltInTools(
      mockWriter,
      { ...mockParams, provider: null as never },
      mockCtx,
    );
    expect((tools as Record<string, unknown>).todo_write).toBeDefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/api/routes/decopilot/built-in-tools/registration.test.ts`
Expected: FAIL with "Expected todo_write to be defined".

- [ ] **Step 3: Register the tool**

Edit `apps/mesh/src/api/routes/decopilot/built-in-tools/index.ts`:

3a. Add the annotation. Find `const BUILTIN_TOOL_ANNOTATIONS: Record<...>` (around line 16) and add a new entry:

```ts
const BUILTIN_TOOL_ANNOTATIONS: Record<
  string,
  { readOnly?: boolean; destructive?: boolean }
> = {
  read_tool_output: { readOnly: true, destructive: false },
  read_resource: { readOnly: true, destructive: false },
  read_prompt: { readOnly: true, destructive: false },
  web_search: { readOnly: true, destructive: false },
  generate_image: { readOnly: false, destructive: false },
  open_in_agent: { readOnly: false, destructive: false },
  subtask: { readOnly: false, destructive: false },
  user_ask: { readOnly: true, destructive: false },
  propose_plan: { readOnly: true, destructive: false },
  enable_tool: { readOnly: true, destructive: false },
  todo_write: { readOnly: false, destructive: false },
};
```

3b. Add the import alongside the other tool imports near the top of the file:

```ts
import { todoWriteTool } from "./todo-write";
```

3c. Register the tool in `buildAllTools`. Find the initial `tools: Record<string, unknown>` declaration (around line 123) and add `todo_write`:

```ts
  const tools: Record<string, unknown> = {
    user_ask: userAskTool,
    todo_write: todoWriteTool,
    propose_plan: proposePlanTool,
    read_tool_output: createReadToolOutputTool({
      toolOutputMap,
    }),
    read_resource: createReadResourceTool({
      passthroughClient,
      toolOutputMap,
      ctx,
    }),
    read_prompt: createReadPromptTool({
      passthroughClient,
      toolOutputMap,
    }),
  };
```

3d. Extend the return type annotation. Find the `return tools as { ... }` block near the end of `buildAllTools` (around line 227) and add `todo_write` to the type:

```ts
  return tools as {
    user_ask: typeof userAskTool;
    todo_write: typeof todoWriteTool;
    propose_plan: typeof proposePlanTool;
    subtask: ReturnType<typeof createSubtaskTool>;
    read_tool_output: ReturnType<typeof createReadToolOutputTool>;
    sandbox: ReturnType<typeof createSandboxTool>;
    read_resource: ReturnType<typeof createReadResourceTool>;
    read_prompt: ReturnType<typeof createReadPromptTool>;
    generate_image: ReturnType<typeof createGenerateImageTool>;
    web_search: ReturnType<typeof createWebSearchTool>;
    take_screenshot: ReturnType<typeof createTakeScreenshotTool>;
    scrape_url: ReturnType<typeof createScrapeUrlTool>;
    inspect_page: ReturnType<typeof createInspectPageTool>;
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/api/routes/decopilot/built-in-tools/registration.test.ts`
Expected: PASS (all existing tests + 4 new tests).

Also run typecheck to confirm the `Record<string, unknown>` cast doesn't hide a type drift:

Run: `bun run --cwd=apps/mesh check`
Expected: no new errors.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/built-in-tools/index.ts apps/mesh/src/api/routes/decopilot/built-in-tools/registration.test.ts
git commit -m "feat(decopilot): register todo_write in built-in tools

Adds the tool to buildAllTools (unconditional, no provider/env gating)
and to BUILTIN_TOOL_ANNOTATIONS for posthog tool_called telemetry."
```

---

## Task 3 — `buildTodoWritePrompt()` and system-prompt wiring

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/constants.ts`
- Modify: `apps/mesh/src/api/routes/decopilot/stream-core.ts`
- Create: `apps/mesh/src/api/routes/decopilot/constants.test.ts` (if absent — check first)

- [ ] **Step 1: Write the failing test**

If `constants.test.ts` already exists, append to it. Otherwise create `apps/mesh/src/api/routes/decopilot/constants.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildTodoWritePrompt } from "./constants";

describe("buildTodoWritePrompt", () => {
  test("mentions the tool name", () => {
    expect(buildTodoWritePrompt()).toContain("todo_write");
  });

  test("specifies the 3+ step threshold", () => {
    expect(buildTodoWritePrompt()).toMatch(/3\+|three or more/i);
  });

  test("specifies the single-in-progress constraint", () => {
    expect(buildTodoWritePrompt()).toMatch(/one .* in_progress|exactly one/i);
  });

  test("explains the full-list rewrite semantics", () => {
    expect(buildTodoWritePrompt()).toMatch(
      /rewrite|replace|full list|entire list/i,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/api/routes/decopilot/constants.test.ts`
Expected: FAIL with "buildTodoWritePrompt is not a function" (or "Cannot find name").

- [ ] **Step 3: Implement `buildTodoWritePrompt()`**

In `apps/mesh/src/api/routes/decopilot/constants.ts`, after `buildDecopilotAgentPrompt()` (around line 75), add:

```ts
/**
 * todo_write usage guidance — included in the system prompt for ALL
 * agents (decopilot + custom), because the tool itself is universally
 * registered.
 */
export function buildTodoWritePrompt(): string {
  return `<todo-write>
You have a \`todo_write\` tool for planning and tracking multi-step work.

- Use it whenever a task has 3+ distinct steps.
- Mark exactly one todo \`in_progress\` at any time.
- Update the list as you work: flip a todo to \`in_progress\` before
  starting it, \`completed\` the moment it finishes. Do not batch
  completions.
- Rewrite the entire list every call — there is no incremental update.
- For trivial (<3 step) work, do not call the tool at all.
- \`content\` is imperative ("Implement X"); \`activeForm\` is
  present-continuous ("Implementing X") and shown in the user's UI
  while the todo is in progress.
</todo-write>`;
}
```

- [ ] **Step 4: Wire into `systemPrompts` in `stream-core.ts`**

In `apps/mesh/src/api/routes/decopilot/stream-core.ts`:

4a. Add the import. Find the existing import line for `constants` (search for `buildDecopilotAgentPrompt`) and extend it:

```ts
import {
  // ... existing imports
  buildDecopilotAgentPrompt,
  buildTodoWritePrompt,
} from "./constants";
```

(Adjust to match the actual existing import style — single-line vs multi-line.)

4b. Find the `systemPrompts` array (around line 724) and insert `buildTodoWritePrompt()` between `connectionsBlock` and `agentPrompt`:

```ts
        const systemPrompts = [
          basePrompt,
          planModePrompt,
          webSearchPrompt,
          repoEnvironmentPrompt,
          promptsBlock,
          agentsBlock,
          connectionsBlock,
          buildTodoWritePrompt(),
          agentPrompt,
        ].filter((s): s is string => Boolean(s?.trim()));
```

- [ ] **Step 5: Run tests**

Run: `bun test apps/mesh/src/api/routes/decopilot/constants.test.ts`
Expected: PASS (4 tests).

Run: `bun run --cwd=apps/mesh check`
Expected: no new errors.

Run any existing stream-core / system-prompt tests to confirm nothing regressed:

Run: `bun test apps/mesh/src/api/routes/decopilot/`
Expected: all PASS.

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/constants.ts apps/mesh/src/api/routes/decopilot/constants.test.ts apps/mesh/src/api/routes/decopilot/stream-core.ts
git commit -m "feat(decopilot): add todo_write system-prompt guidance

New buildTodoWritePrompt() lives in constants.ts and is slotted into
systemPrompts between connectionsBlock and agentPrompt — making the
guidance available to decopilot and custom agents alike."
```

---

## Task 4 — `getCurrentTodos()` helper

**Files:**
- Create: `apps/mesh/src/api/routes/decopilot/current-todos.ts`
- Test: `apps/mesh/src/api/routes/decopilot/current-todos.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/api/routes/decopilot/current-todos.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { getCurrentTodos } from "./current-todos";
import type { Todo } from "./built-in-tools/todo-write";

function makeAssistantMessage(parts: unknown[]): UIMessage {
  return { id: "m", role: "assistant", parts } as unknown as UIMessage;
}

function todoWritePart(todos: Todo[], state = "output-available") {
  return {
    type: "tool-todo_write",
    state,
    input: { todos },
    output: { ok: true, count: todos.length },
    toolCallId: "tc",
  };
}

describe("getCurrentTodos", () => {
  test("returns [] when no todo_write call exists", () => {
    const messages = [
      makeAssistantMessage([{ type: "text", text: "hello" }]),
    ];
    expect(getCurrentTodos(messages)).toEqual([]);
  });

  test("returns the todos from the only todo_write call", () => {
    const todos: Todo[] = [
      { content: "a", status: "pending", activeForm: "doing a" },
    ];
    const messages = [makeAssistantMessage([todoWritePart(todos)])];
    expect(getCurrentTodos(messages)).toEqual(todos);
  });

  test("returns the LATEST todo_write call when multiple exist", () => {
    const older: Todo[] = [
      { content: "old", status: "completed", activeForm: "doing old" },
    ];
    const newer: Todo[] = [
      { content: "new", status: "in_progress", activeForm: "doing new" },
    ];
    const messages = [
      makeAssistantMessage([todoWritePart(older)]),
      makeAssistantMessage([{ type: "text", text: "thinking..." }]),
      makeAssistantMessage([todoWritePart(newer)]),
    ];
    expect(getCurrentTodos(messages)).toEqual(newer);
  });

  test("accepts input-available state (output not yet flushed)", () => {
    const todos: Todo[] = [
      { content: "x", status: "pending", activeForm: "doing x" },
    ];
    const messages = [
      makeAssistantMessage([todoWritePart(todos, "input-available")]),
    ];
    expect(getCurrentTodos(messages)).toEqual(todos);
  });

  test("ignores non-todo_write tool parts", () => {
    const messages = [
      makeAssistantMessage([
        {
          type: "tool-user_ask",
          state: "output-available",
          input: { prompt: "?", type: "text" },
        },
      ]),
    ];
    expect(getCurrentTodos(messages)).toEqual([]);
  });

  test("ignores user messages", () => {
    const todos: Todo[] = [
      { content: "x", status: "pending", activeForm: "doing x" },
    ];
    const messages = [
      // user "messages" can never have tool parts, but guard anyway
      { id: "u", role: "user", parts: [todoWritePart(todos)] } as unknown as UIMessage,
    ];
    expect(getCurrentTodos(messages)).toEqual([]);
  });

  test("returns [] when input fails schema validation", () => {
    const messages = [
      makeAssistantMessage([
        {
          type: "tool-todo_write",
          state: "output-available",
          input: { todos: [{ content: "", status: "pending", activeForm: "" }] },
          toolCallId: "tc",
        },
      ]),
    ];
    // empty content fails min(1)
    expect(getCurrentTodos(messages)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/api/routes/decopilot/current-todos.test.ts`
Expected: FAIL with "Cannot find module './current-todos'".

- [ ] **Step 3: Implement the helper**

Create `apps/mesh/src/api/routes/decopilot/current-todos.ts`:

```ts
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
import {
  TodoWriteInputSchema,
  type Todo,
} from "./built-in-tools/todo-write";

interface UnknownPart {
  type?: unknown;
  state?: unknown;
  input?: unknown;
}

const TODO_WRITE_PART_TYPE = "tool-todo_write";
const READABLE_STATES = new Set([
  "input-available",
  "output-available",
]);

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/api/routes/decopilot/current-todos.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/current-todos.ts apps/mesh/src/api/routes/decopilot/current-todos.test.ts
git commit -m "feat(decopilot): add getCurrentTodos helper

Scans assistant message parts backwards for the latest valid todo_write
tool call. Returns [] when no valid call is in the loaded window."
```

---

## Task 5 — `TodosPanel` React component

**Files:**
- Create: `apps/mesh/src/web/components/chat/todos-panel.tsx`

- [ ] **Step 1: Confirm icon library and Tailwind tokens**

Run: `grep -rn 'from "@deco/ui/components/icon"' apps/mesh/src/web/components/chat | head -5`
Use whichever icon import pattern the existing chat components use. If unsure, fall back to plain Unicode (`✓`, `○`, `●`) — no external icon dep.

- [ ] **Step 2: Implement the panel**

Create `apps/mesh/src/web/components/chat/todos-panel.tsx`:

```tsx
/**
 * TodosPanel — read-only sidebar for the per-thread todo list maintained
 * by the model via the `todo_write` tool. Derives state from the same
 * UIMessage stream the chat renders; no API call of its own.
 *
 * Distinct from the org-wide `TasksPanelColumn` (automations) — these
 * todos are per-thread, ephemeral, and model-managed.
 */

import { cn } from "@deco/ui/lib/utils.js";
import type { UIMessage } from "ai";
import { getCurrentTodos } from "@/api/routes/decopilot/current-todos";
import type { Todo } from "@/api/routes/decopilot/built-in-tools/todo-write";

interface TodosPanelProps {
  messages: readonly UIMessage[];
}

export function TodosPanel({ messages }: TodosPanelProps) {
  const todos = getCurrentTodos(messages);
  if (todos.length === 0) return null;

  return (
    <aside
      data-testid="todos-panel"
      className="h-full flex flex-col gap-2 p-3 bg-background"
    >
      <header className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Todos
      </header>
      <ul className="flex flex-col gap-1.5">
        {todos.map((todo, i) => (
          <TodoRow key={i} todo={todo} />
        ))}
      </ul>
    </aside>
  );
}

function TodoRow({ todo }: { todo: Todo }) {
  const isCompleted = todo.status === "completed";
  const isInProgress = todo.status === "in_progress";
  const label = isInProgress ? todo.activeForm : todo.content;

  return (
    <li
      className={cn(
        "flex items-start gap-2 text-sm",
        isCompleted && "text-muted-foreground line-through opacity-70",
      )}
    >
      <StatusMark status={todo.status} />
      <span className="leading-snug">{label}</span>
    </li>
  );
}

function StatusMark({ status }: { status: Todo["status"] }) {
  if (status === "completed") {
    return <span aria-label="completed" className="mt-0.5">✓</span>;
  }
  if (status === "in_progress") {
    return (
      <span
        aria-label="in progress"
        className="mt-0.5 inline-block w-2 h-2 rounded-full bg-primary animate-pulse"
      />
    );
  }
  return (
    <span
      aria-label="pending"
      className="mt-0.5 inline-block w-2 h-2 rounded-full border border-muted-foreground"
    />
  );
}
```

- [ ] **Step 3: Verify TypeScript and lint**

Run: `bun run --cwd=apps/mesh check`
Expected: no errors related to the new file.

Run: `bun run lint`
Expected: no errors. (If the design-system Tailwind plugin flags a token, swap to the suggested one — the values in this file all map to shadcn tokens already used in mesh.)

- [ ] **Step 4: Commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/todos-panel.tsx
git commit -m "feat(decopilot): add TodosPanel react component

Renders the current todo list derived from the chat message stream.
Returns null when empty. Read-only — no user interaction."
```

---

## Task 6 — Mount `TodosColumn` in the agent-shell layout

**Files:**
- Create: `apps/mesh/src/web/layouts/agent-shell-layout/todos-column.tsx`
- Modify: the parent layout that currently mounts `TasksPanelColumn` and `ChatMainPanelGroup`

- [ ] **Step 1: Locate the parent layout**

Run: `grep -rn "TasksPanelColumn" apps/mesh/src/web/layouts/agent-shell-layout/`
Identify the file that imports and renders `TasksPanelColumn` alongside `ChatMainPanelGroup`. That's the integration point. (If the layout file is not in `agent-shell-layout/`, follow imports.)

Then run: `grep -rn "useChatContext\|ChatContext\|messages" apps/mesh/src/web/components/chat/chat-context.tsx | head -20` to find the hook/context that exposes the current chat's `messages: UIMessage[]`. Note the exact hook name and return shape — the new column needs it.

- [ ] **Step 2: Implement `TodosColumn`**

Create `apps/mesh/src/web/layouts/agent-shell-layout/todos-column.tsx`. Replace `useChatMessages` with the actual hook surfaced in Step 1 (and the import path with whatever exposes it).

```tsx
/**
 * TodosColumn — fixed-width right column hosting the per-thread TodosPanel.
 *
 * Mounted as a sibling of TasksPanelColumn (org-wide automations) and
 * ChatMainPanelGroup (chat + main). The column auto-hides when there
 * are no todos in the loaded message window — so a fresh thread shows
 * nothing until the model first calls `todo_write`.
 */

import { Suspense } from "react";
// Replace with the exact import the codebase exposes (see Step 1 grep).
import { useChatMessages } from "@/web/components/chat/chat-context";
import { TodosPanel } from "@/web/components/chat/todos-panel";
import { getCurrentTodos } from "@/api/routes/decopilot/current-todos";

const TODOS_COLUMN_WIDTH_PX = 280;

function TodosColumnInner() {
  const messages = useChatMessages();
  const todos = messages ? getCurrentTodos(messages) : [];
  if (todos.length === 0) return null;

  return (
    <aside
      className="shrink-0 h-full bg-sidebar pb-1"
      style={{ width: `${TODOS_COLUMN_WIDTH_PX}px` }}
    >
      <div className="h-full p-0.5 pt-0.25">
        <div className="h-full bg-background rounded-[0.75rem] overflow-hidden card-shadow">
          <TodosPanel messages={messages!} />
        </div>
      </div>
    </aside>
  );
}

export function TodosColumn() {
  return (
    <Suspense fallback={null}>
      <TodosColumnInner />
    </Suspense>
  );
}
```

Note: we compute `getCurrentTodos` here (in addition to inside `TodosPanel`) so the column can fully unmount when empty — leaving zero DOM rather than a blank shell. The double computation is cheap (a single backwards scan) and worth the cleaner layout behavior.

- [ ] **Step 3: Mount in the parent layout**

In the layout file located in Step 1, import and render `TodosColumn` as a sibling of `TasksPanelColumn` (on the opposite side of `ChatMainPanelGroup`):

```tsx
import { TodosColumn } from "./todos-column";
// ...
<TasksPanelColumn />
<ChatMainPanelGroup ... />
<TodosColumn />
```

Exact placement (left vs right of the chat panel) is a design call — default to **right of the chat panel** so the org-wide tasks and per-thread todos sit on opposite sides.

- [ ] **Step 4: TypeScript + lint**

Run: `bun run --cwd=apps/mesh check`
Expected: no errors. Common failure: `useChatMessages` import path wrong → fix import based on Step 1 grep.

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/web/layouts/agent-shell-layout/todos-column.tsx <parent-layout-file>
git commit -m "feat(decopilot): mount TodosColumn alongside TasksPanelColumn

The per-thread todos column auto-hides when getCurrentTodos returns
empty. Sibling of the existing org-wide TasksPanelColumn (automations)
and ChatMainPanelGroup. Width: 280px, matching TasksPanelColumn."
```

---

## Task 7 — End-to-end manual smoke test

**Files:** none (manual verification)

- [ ] **Step 1: Run the dev environment**

Run: `bun run dev`
Wait for the server + client to come up (mesh API on the bound port, Vite on 4000).

- [ ] **Step 2: Open a fresh decopilot chat and trigger todo_write**

Navigate to a workspace's decopilot. Send: `Please plan a 4-step refactor: extract types, add tests, migrate callsites, delete the old file. Use todo_write.`

Expected:
- The chat stream shows a tool call rendered with the default tool-call UI.
- The `TodosColumn` appears on the right with 4 items, one in `in_progress`.
- The in-progress row shows the `activeForm` string with a pulsing dot.

- [ ] **Step 3: Trigger an update**

Send: `Mark the first todo completed and start the next one.`

Expected:
- Another `todo_write` call appears in the chat stream.
- The sidebar updates: first item shows ✓ + strike-through, second item now shows the pulse dot with its `activeForm`.

- [ ] **Step 4: Confirm auto-hide on a fresh thread**

Open a new chat (do not call `todo_write`). Expected: `TodosColumn` is not visible at all.

- [ ] **Step 5: Confirm posthog event fires**

Tail the dev server logs (or look at posthog if configured):
- Expected: a `tool_called` event with `tool_name: "todo_write"` and `tool_source: "builtin"`.

- [ ] **Step 6: Run the full test suite and commit any fixups**

Run: `bun test`
Run: `bun run --cwd=apps/mesh check`
Run: `bun run lint`
Run: `bun run fmt:check`

Expected: all green. If anything fails, fix it and commit:

```bash
git add <files>
git commit -m "fix(decopilot): <what>"
```

---

## Final check

- [ ] **Spec coverage:** every section of `specs/2026-05-12-decopilot-todo-write-design.md` is implemented:
  - Tool surface (Task 1)
  - Storage = message stream (Tasks 1, 4)
  - System prompt block (Task 3)
  - Sidebar frontend (Tasks 5, 6)
  - All listed files added/edited (Tasks 1-6)
- [ ] **Push the branch and open a PR**

```bash
git push -u origin tlgimenes/decopilot-compact-thread
gh pr create --base main --title "feat(decopilot): add todo_write tool + sidebar (Claude Code-style)" --body "$(cat <<'EOF'
## Summary

- New built-in tool `todo_write` for per-thread, model-managed todos
- Single-call replace-whole-list semantics (mirrors Claude Code's TodoWrite)
- Source of truth: latest `todo_write` tool-call in the message stream — no new tables
- New `TodosColumn` sidebar renders the current list; auto-hides when empty
- System-prompt guidance available to decopilot + custom agents

## Test plan

- [ ] `bun test`
- [ ] `bun run check`
- [ ] `bun run lint`
- [ ] Manual smoke: decopilot writes a 4-step list, sidebar appears, in-progress row pulses
- [ ] Manual smoke: subsequent `todo_write` updates the sidebar
- [ ] Manual smoke: fresh chat has no sidebar until the first `todo_write`

Spec: `specs/2026-05-12-decopilot-todo-write-design.md`
EOF
)"
```

# Decopilot todos UI — relocate to chat highlight slot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the desktop-only right-side `TodosColumn` with a persistent, click-to-expand todo chip rendered in the chat highlight slot just above the chat input. Backend (`todo_write` tool, `current-todos` helper) is untouched.

**Architecture:** A single new React component `TodosHighlight` lives inside `apps/mesh/src/web/components/chat/highlight/`. It reads the message stream via `useChatStream()`, derives the current todo list via the existing `getCurrentTodos()` helper, renders a one-line chip when todos exist, and expands an overlay panel on click. A pure helper `deriveChipLabel()` computes the chip's `{ icon, activity, progress }` strings — kept in its own module for trivial unit testing without DOM. The `ChatHighlight` parent is refactored so the priority banner tree returns a `bannerNode` value (instead of early-returning) and renders alongside `TodosHighlight` inside one persistent absolutely-positioned wrapper. `TodosColumn` and `TodosPanel` are deleted.

**Tech Stack:** React 19, TypeScript, Tailwind v4, Bun test runner. No new dependencies.

**Spec:** `specs/2026-05-13-decopilot-todos-highlight-ui-design.md`

---

## Task 1: Pure helper `deriveChipLabel` + unit tests (TDD)

The chip's text is a pure function of the todo list. Land it first with tests so the component layer is built on a verified foundation.

**Resolution of spec ambiguity:** The spec sketches `deriveChipLabel` returning `{ icon, text }` (combined string), but also requires "progress count pinned right and survives truncation". A single combined string can't be partially truncated. This plan splits the return into `{ icon, activity, progress }` so the chip can place `activity` in a `flex-1 truncate` slot and `progress` in a `shrink-0` slot. The spec's chip state table still drives the values verbatim — only the carrier shape changes.

**Files:**
- Create: `apps/mesh/src/web/components/chat/highlight/derive-chip-label.ts`
- Create: `apps/mesh/src/web/components/chat/highlight/derive-chip-label.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `apps/mesh/src/web/components/chat/highlight/derive-chip-label.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Todo } from "@/api/routes/decopilot/built-in-tools/todo-write";
import { deriveChipLabel } from "./derive-chip-label";

const todo = (
  status: Todo["status"],
  content: string,
  activeForm = content.replace(/^[A-Z]/, (c) => c.toLowerCase()),
): Todo => ({
  status,
  content,
  activeForm: `${activeForm.charAt(0).toUpperCase()}${activeForm.slice(1)}ing`,
});

describe("deriveChipLabel", () => {
  test("returns pending icon and 'not started' summary when nothing is in progress", () => {
    const result = deriveChipLabel([
      todo("pending", "Read the file"),
      todo("pending", "Write the test"),
      todo("pending", "Implement"),
    ]);
    expect(result).toEqual({
      icon: "pending",
      activity: "3 todos",
      progress: "not started",
    });
  });

  test("returns in_progress icon and activeForm when exactly one todo is in progress", () => {
    const result = deriveChipLabel([
      todo("completed", "Read the file"),
      {
        status: "in_progress",
        content: "Implement the function",
        activeForm: "Implementing the function",
      },
      todo("pending", "Add tests"),
    ]);
    expect(result).toEqual({
      icon: "in_progress",
      activity: "Implementing the function",
      progress: "1/3 done",
    });
  });

  test("returns in_progress icon and a count when more than one todo is in progress", () => {
    const result = deriveChipLabel([
      {
        status: "in_progress",
        content: "First",
        activeForm: "Doing first",
      },
      {
        status: "in_progress",
        content: "Second",
        activeForm: "Doing second",
      },
      todo("completed", "Third"),
    ]);
    expect(result).toEqual({
      icon: "in_progress",
      activity: "2 in progress",
      progress: "1/3 done",
    });
  });

  test("returns completed icon when every todo is done", () => {
    const result = deriveChipLabel([
      todo("completed", "One"),
      todo("completed", "Two"),
      todo("completed", "Three"),
    ]);
    expect(result).toEqual({
      icon: "completed",
      activity: "All done",
      progress: "3/3",
    });
  });

  test("tolerates the empty list (caller is responsible for early return)", () => {
    const result = deriveChipLabel([]);
    expect(result.icon).toBe("pending");
    // Specific copy doesn't matter — caller short-circuits on length === 0.
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
bun test apps/mesh/src/web/components/chat/highlight/derive-chip-label.test.ts
```

Expected: FAIL — `Cannot find module './derive-chip-label'`.

- [ ] **Step 3: Write the implementation**

Create `apps/mesh/src/web/components/chat/highlight/derive-chip-label.ts`:

```ts
/**
 * Pure helper computing the collapsed-chip label for `TodosHighlight`.
 *
 * Splits the chip's text into `activity` (truncatable, flex-1 in the chip
 * layout) and `progress` (pinned right, shrink-0). The `icon` field drives
 * the leading status mark.
 *
 * State table — keep in sync with the design spec:
 *
 *   • all pending             → { pending,     "{n} todos",          "not started" }
 *   • one in_progress         → { in_progress, "{activeForm}",       "{done}/{total} done" }
 *   • multi in_progress       → { in_progress, "{k} in progress",    "{done}/{total} done" }
 *   • all completed           → { completed,   "All done",           "{total}/{total}" }
 *
 * Empty list is tolerated for safety but the caller short-circuits on
 * `todos.length === 0` and the chip never renders.
 */
import type { Todo } from "@/api/routes/decopilot/built-in-tools/todo-write";

export type ChipIcon = "pending" | "in_progress" | "completed";

export interface ChipLabel {
  icon: ChipIcon;
  activity: string;
  progress: string;
}

export function deriveChipLabel(todos: Todo[]): ChipLabel {
  const inProgress = todos.filter((t) => t.status === "in_progress");
  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;

  if (total > 0 && completed === total) {
    return { icon: "completed", activity: "All done", progress: `${total}/${total}` };
  }
  if (inProgress.length === 1) {
    return {
      icon: "in_progress",
      activity: inProgress[0].activeForm,
      progress: `${completed}/${total} done`,
    };
  }
  if (inProgress.length > 1) {
    return {
      icon: "in_progress",
      activity: `${inProgress.length} in progress`,
      progress: `${completed}/${total} done`,
    };
  }
  return {
    icon: "pending",
    activity: `${total} todos`,
    progress: "not started",
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
bun test apps/mesh/src/web/components/chat/highlight/derive-chip-label.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Format and commit**

Run:
```bash
bun run fmt
git add apps/mesh/src/web/components/chat/highlight/derive-chip-label.ts \
        apps/mesh/src/web/components/chat/highlight/derive-chip-label.test.ts
git commit -m "feat(decopilot): add deriveChipLabel pure helper for todos chip"
```

---

## Task 2: `TodosHighlight` component (chip + expanded panel + auto-collapse)

The full component in one task — chip JSX, expanded panel JSX (ported from `todos-panel.tsx`), local `expanded` state, the `bannerActive` prop, and the `useEffect` that clears state when a banner fires. Component is built but not yet wired into `ChatHighlight` (Task 3).

**Files:**
- Create: `apps/mesh/src/web/components/chat/highlight/todos.tsx`

- [ ] **Step 1: Create the component file**

Create `apps/mesh/src/web/components/chat/highlight/todos.tsx`:

```tsx
/**
 * TodosHighlight — persistent collapsed chip + click-to-expand panel for the
 * per-thread todo list maintained by the model via `todo_write`.
 *
 * Lives inside `ChatHighlight`, rendered alongside (but visually below) the
 * priority banner stack. Reads the same UIMessage stream the chat renders;
 * no API call of its own.
 *
 * Auto-collapse on banner fire: a `useEffect` watches the `bannerActive`
 * prop and clears local `expanded` state when it flips true. The render
 * also guards against showing the panel while a banner is active, which
 * avoids a one-frame flash before the effect runs.
 *
 * Replaces the deleted `TodosPanel` / `TodosColumn` pair.
 */

import { useEffect, useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { ChevronDown, ChevronUp } from "@untitledui/icons";
import type { Todo } from "@/api/routes/decopilot/built-in-tools/todo-write";
import { getCurrentTodos } from "@/api/routes/decopilot/current-todos";
import { useChatStream } from "../context";
import { type ChipIcon, deriveChipLabel } from "./derive-chip-label";

interface TodosHighlightProps {
  bannerActive: boolean;
}

export function TodosHighlight({ bannerActive }: TodosHighlightProps) {
  const { messages } = useChatStream();
  const todos = getCurrentTodos(messages);
  const [expanded, setExpanded] = useState(false);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — collapses the expanded panel when a higher-priority banner fires; one-shot state reset on prop transition has no derived-state equivalent
  useEffect(() => {
    if (bannerActive) setExpanded(false);
  }, [bannerActive]);

  if (todos.length === 0) return null;

  const label = deriveChipLabel(todos);
  const showPanel = expanded && !bannerActive;

  return (
    <div className="px-0.5">
      {showPanel ? <ExpandedPanel todos={todos} /> : null}
      <button
        type="button"
        data-testid="todos-chip"
        aria-expanded={showPanel}
        onClick={() => setExpanded((prev) => !prev)}
        className={cn(
          "flex items-center gap-2 w-full px-3 py-2 mb-2 rounded-lg",
          "border border-dashed bg-background text-sm shadow",
          "text-left hover:bg-accent/50 transition-colors",
        )}
      >
        <StatusMark status={label.icon} />
        <span className="flex-1 min-w-0 truncate">{label.activity}</span>
        <span className="text-xs text-muted-foreground shrink-0">
          {label.progress}
        </span>
        <span className="text-muted-foreground shrink-0">
          {showPanel ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>
    </div>
  );
}

function ExpandedPanel({ todos }: { todos: readonly Todo[] }) {
  return (
    <div
      data-testid="todos-expanded-panel"
      className={cn(
        "max-h-[40vh] overflow-y-auto",
        "px-3 py-2.5 mb-2 rounded-lg border border-dashed bg-background shadow",
      )}
    >
      <header className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
        Todos
      </header>
      <ul className="flex flex-col gap-1.5">
        {todos.map((todo, i) => (
          <TodoRow key={i} todo={todo} />
        ))}
      </ul>
    </div>
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

function StatusMark({ status }: { status: ChipIcon | Todo["status"] }) {
  if (status === "completed") {
    return (
      <span aria-label="completed" className="mt-0.5 shrink-0">
        ✓
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span
        aria-label="in progress"
        className="mt-0.5 inline-block w-2 h-2 rounded-full bg-primary animate-pulse shrink-0"
      />
    );
  }
  return (
    <span
      aria-label="pending"
      className="mt-0.5 inline-block w-2 h-2 rounded-full border border-muted-foreground shrink-0"
    />
  );
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
bun run check
```

Expected: PASS. (`ChevronUp`/`ChevronDown` are confirmed exports of `@untitledui/icons`, used elsewhere in the codebase — see `apps/mesh/src/web/routes/orgs/monitoring/audit.tsx`.)

- [ ] **Step 3: Lint**

Run:
```bash
bun run lint
```

Expected: PASS. The `oxlint-disable-next-line ban-use-effect/ban-use-effect` comment with its justification text is required for the `useEffect` block — verify it is exactly as written in Step 1.

- [ ] **Step 4: Format and commit**

Run:
```bash
bun run fmt
git add apps/mesh/src/web/components/chat/highlight/todos.tsx
git commit -m "feat(decopilot): add TodosHighlight chip + expanded panel"
```

---

## Task 3: Refactor `ChatHighlight` to render banner + chip side by side

`ChatHighlight` currently returns *early* from each priority branch with its own `<div className="absolute bottom-full ...">` wrapper. To stack the chip alongside an active banner, the wrapper has to be rendered unconditionally. Refactor the priority `if/return` tree into a `bannerNode` ternary, then render `bannerNode` + `<TodosHighlight>` inside one persistent wrapper.

**Files:**
- Modify: `apps/mesh/src/web/components/chat/highlight/index.tsx`

- [ ] **Step 1: Refactor the priority tree and add `TodosHighlight`**

Open `apps/mesh/src/web/components/chat/highlight/index.tsx`. Replace the block from the comment `// Priority: user_ask > propose_plan > approval > error > warning` down to (and including) the final `return null;` with:

```tsx
  // Priority: user_ask > propose_plan > approval > error > warning.
  // Credits-exhausted is a separate modal path (handled below). Other
  // banners share the absolutely-positioned wrapper with TodosHighlight
  // so the chip and an active banner can stack.

  // Credit/quota errors get a dedicated modal with inline top-up — keep
  // its own return, it isn't part of the banner stack.
  if (!isStreaming && error && isCreditError(error)) {
    return <CreditsExhaustedBanner onDismiss={clearError} />;
  }

  const bannerNode: React.ReactNode = isWaitingForUserInput ? (
    <UserAskQuestionHighlight
      userAskParts={userAskParts}
      isStreaming={isStreaming}
      onSubmit={handleUserAskSubmit}
    />
  ) : pendingPlans.length > 0 ? (
    <ProposePlanHighlight
      plans={pendingPlans}
      isStreaming={isStreaming}
      onApprove={handlePlanApprove}
      onDismiss={handlePlanDismiss}
    />
  ) : pendingApprovals.length > 0 || (isStreaming && isWaitingForApprovals) ? (
    <ApprovalHighlight
      approvals={pendingApprovals}
      isStreaming={isStreaming}
      onRespond={handleApprovalRespond}
    />
  ) : !isStreaming && error ? (
    <StatusHighlight
      variant="error"
      error={error}
      onDismiss={clearError}
      onFixInChat={handleFixInChat}
    />
  ) : !isStreaming &&
    finishReason &&
    finishReason !== "stop" &&
    !isWaitingForApprovals ? (
    <StatusHighlight
      variant="warning"
      finishReason={finishReason}
      onDismiss={clearFinishReason}
      onContinue={handleContinue}
    />
  ) : null;

  return (
    <div className="absolute bottom-full left-0 right-0 bg-background">
      {bannerNode}
      <TodosHighlight bannerActive={bannerNode !== null} />
    </div>
  );
}
```

Then add the import at the top of the file (after the existing imports from `./user-ask-question`):

```tsx
import { TodosHighlight } from "./todos";
```

Also remove the import for `userAskParts` typing if the new code path no longer references `UserAskToolPart` directly — leave it untouched if still used elsewhere in the file (it is used in `handleUserAskSubmit`).

**Note on the `userAskParts` null-vs-array shape:** the existing code computes `userAskParts` as `null | Part[]` and `isWaitingForUserInput` as `number | undefined`. The new ternary preserves both; `<UserAskQuestionHighlight userAskParts={userAskParts} />` is only reached when `isWaitingForUserInput` is truthy, which guarantees `userAskParts` is non-null. The existing prop typing of `UserAskQuestionHighlight` already handles this — no signature change needed.

- [ ] **Step 2: Type-check**

Run:
```bash
bun run check
```

Expected: PASS. If TypeScript complains that `userAskParts` is `null` where a non-null array is required, narrow it inline:

```tsx
  ) : isWaitingForUserInput && userAskParts ? (
    <UserAskQuestionHighlight
```

Update the condition only if the checker requires it.

- [ ] **Step 3: Smoke-check by booting dev server**

Run:
```bash
bun run dev
```

In the dev URL, open a decopilot thread. Verify nothing crashes and the chat highlight area renders empty (no todos yet). Stop the server with Ctrl-C.

(This smoke catches import path mistakes, JSX shape issues, etc., before subsequent tasks.)

- [ ] **Step 4: Lint, format, commit**

Run:
```bash
bun run lint
bun run fmt
git add apps/mesh/src/web/components/chat/highlight/index.tsx
git commit -m "feat(decopilot): render TodosHighlight in ChatHighlight wrapper"
```

---

## Task 4: Delete `TodosColumn` / `TodosPanel`, update agent shell layout

The chip is wired up — now remove the old right-column UI and simplify the surrounding layout.

**Files:**
- Delete: `apps/mesh/src/web/components/chat/todos-panel.tsx`
- Delete: `apps/mesh/src/web/layouts/agent-shell-layout/todos-column.tsx`
- Modify: `apps/mesh/src/web/layouts/agent-shell-layout/index.tsx`

- [ ] **Step 1: Delete the files**

Run:
```bash
rm apps/mesh/src/web/components/chat/todos-panel.tsx
rm apps/mesh/src/web/layouts/agent-shell-layout/todos-column.tsx
```

- [ ] **Step 2: Remove the import and usage from the agent shell layout**

Open `apps/mesh/src/web/layouts/agent-shell-layout/index.tsx`.

Remove the import line:

```tsx
import { TodosColumn } from "./todos-column";
```

Replace this block (currently around lines 521–533 in the desktop branch):

```tsx
            <Chat.ActiveTaskProvider taskId={layout.taskId}>
              <Suspense fallback={<Chat.Skeleton />}>
                <div className="flex flex-row flex-1 min-h-0">
                  <ChatMainPanelGroup
                    virtualMcpId={virtualMcpId}
                    taskId={layout.taskId}
                    chatOpen={layout.chatOpen}
                    mainOpen={layout.mainOpen}
                    chatContent={<ActiveTaskBoundary />}
                  />
                  <TodosColumn />
                </div>
              </Suspense>
            </Chat.ActiveTaskProvider>
```

with:

```tsx
            <Chat.ActiveTaskProvider taskId={layout.taskId}>
              <Suspense fallback={<Chat.Skeleton />}>
                <ChatMainPanelGroup
                  virtualMcpId={virtualMcpId}
                  taskId={layout.taskId}
                  chatOpen={layout.chatOpen}
                  mainOpen={layout.mainOpen}
                  chatContent={<ActiveTaskBoundary />}
                />
              </Suspense>
            </Chat.ActiveTaskProvider>
```

(The `flex-row` wrapper existed only because `ChatMainPanelGroup` and `TodosColumn` were siblings — `ChatMainPanelGroup` is now the sole child, so the wrapper is removed.)

- [ ] **Step 3: Update the layout doc comment at the top of the file**

Replace these lines in the header comment (around lines 18–23):

```tsx
 *               • Chat.Provider
 *                 └── VmEventsBridge
 *                     └── Chat.ActiveTaskProvider
 *                         └── flex-row
 *                             ├── ChatMainPanelGroup
 *                             └── TodosColumn
```

with:

```tsx
 *               • Chat.Provider
 *                 └── VmEventsBridge
 *                     └── Chat.ActiveTaskProvider
 *                         └── ChatMainPanelGroup
 *                             (the per-thread todo list is rendered
 *                              by TodosHighlight inside ChatHighlight,
 *                              not as a side column)
```

- [ ] **Step 4: Type-check, lint, format**

Run:
```bash
bun run check
bun run lint
bun run fmt
```

All must PASS. `bun run check` will catch any other file still importing `TodosColumn` or `TodosPanel`. Knip would flag these as dead exports if missed by check — since the spec forbids modifying knip config, an unexpected knip warning here should be resolved by removing the actual unused export, not by silencing it.

- [ ] **Step 5: Commit**

Run:
```bash
git add -A apps/mesh/src/web/components/chat/todos-panel.tsx \
          apps/mesh/src/web/layouts/agent-shell-layout/todos-column.tsx \
          apps/mesh/src/web/layouts/agent-shell-layout/index.tsx
git commit -m "feat(decopilot): remove TodosColumn — todos now live in highlight chip"
```

---

## Task 5: Manual smoke test + final verification

Spec verification checklist runs at the end, against a real running app.

- [ ] **Step 1: Run the full check suite**

Run:
```bash
bun run check
bun run lint
bun test apps/mesh/src/web/components/chat/highlight/derive-chip-label.test.ts
```

All must PASS.

- [ ] **Step 2: Boot the dev environment**

Run:
```bash
bun run dev
```

Wait for the server to be ready (migrations + client + server). Open the URL it prints.

- [ ] **Step 3: Smoke — chip appears on first `todo_write`**

In a decopilot thread, send the model a prompt that triggers multi-step planning (e.g., "Write a small TypeScript utility with at least three steps and use the todo_write tool to plan"). Verify:

- Before the first `todo_write`, no chip appears above the chat input.
- After the model calls `todo_write` with a list, the chip appears above the input with format matching the `deriveChipLabel` state table:
  - Pending-only list → `○ N todos · not started`
  - One in-progress → `● {activeForm} · {done}/{total} done`
  - All completed → `✓ All done · {total}/{total}`

- [ ] **Step 4: Smoke — expand/collapse**

- Click the chip. The expanded panel overlays *upward* over the chat history (does not push messages up or input down) and shows the full list with status marks.
- Click the chip again. The panel collapses.
- Click again to expand, then scroll the chat history — the chip and expanded panel stay pinned above the input (they live in the highlight slot, not in the chat scroll).

- [ ] **Step 5: Smoke — banner auto-collapse**

While the chip is expanded, trigger an error (e.g., briefly invalidate a credential to force a tool error, or send an over-long prompt to hit a finish-reason warning):

- The expanded panel collapses the moment the banner appears.
- The banner sits *above* the collapsed chip; the chip remains visible.
- Dismiss the banner. The chip stays collapsed (does **not** auto-pop). Manually click the chip to confirm expansion still works after the banner cleared.

- [ ] **Step 6: Smoke — right column is gone**

Confirm visually that the desktop layout no longer has a 280px reserved column on the right of the chat — `ChatMainPanelGroup` now extends to the right edge of the available area.

- [ ] **Step 7: Smoke — mobile viewport**

In browser devtools, switch to a phone viewport. Reload. Verify:
- The chip appears in the same position (just above the chat input) on mobile.
- The expanded panel honors the 40vh cap (does not exceed roughly 40% of viewport height).

- [ ] **Step 8: Stop dev server, final commit if any drift**

Stop the dev server. If `bun run fmt` flagged any drift during the previous steps, commit it:

```bash
bun run fmt
git status
# If anything changed: git add -A && git commit -m "[chore]: format"
```

If `git status` is clean, you're done.

---

## Spec coverage check

| Spec section | Implemented in |
|---|---|
| Decision 1 (chip + overlay-expanded panel) | Task 2 |
| Decision 2 (replace `TodosColumn`) | Task 4 |
| Decision 3 (current-activity chip content) | Task 1 (`deriveChipLabel`) |
| Decision 4 (multi-in-progress fallback) | Task 1 (test + impl) |
| Decision 5 (overlay upward, `max-h-[40vh]` + scroll) | Task 2 (`ExpandedPanel`) |
| Decision 6 (banner above chip) | Task 3 (`bannerNode` rendered before `TodosHighlight`) |
| Decision 7 (auto-collapse on banner fire, no re-pop) | Task 2 (`useEffect` + render guard) |
| Decision 8 (never auto-expand) | Task 2 (initial `useState(false)`, no auto-set) |
| Decision 9 (no click-outside / Escape) | Not implemented (intentional, out of scope) |
| Edge case — empty list | Task 2 (`if (todos.length === 0) return null`) |
| Edge case — long `activeForm` | Task 2 (`flex-1 min-w-0 truncate`) |
| Edge case — long list | Task 2 (`max-h-[40vh] overflow-y-auto`) |
| Edge case — mobile | Task 4 (chip naturally inherits highlight slot) + Task 5 Step 7 (verified) |
| Testing — `deriveChipLabel` unit test | Task 1 |
| Testing — manual smoke | Task 5 |
| Out of scope items | Not implemented (intentional) |

Every spec decision has a task; every edge case has a code path; every test the spec calls "must-have" exists.

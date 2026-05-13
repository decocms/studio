# Decopilot collapsible highlights — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify all chat-highlight banners (question, plan, approval, error, warning, todos) onto one collapsible shell, and switch `ChatHighlight` from priority-based mutual exclusion to concurrent rendering of any matching condition.

**Architecture:** One new component, `CollapsibleHighlight`, owns the collapse mechanism (chip header, body with `hidden` attribute to preserve form state, default-expanded prop, variant-driven backdrop). Each existing banner file becomes a thin adapter that maps its domain state into `CollapsibleHighlight` props. `ChatHighlight` flattens its `if/else if` priority cascade into independent conditionals; banners stack in severity-descending order, with the most-actionable closest to the chat input.

**Tech Stack:** React 19 + React Compiler, TypeScript, Tailwind v4, `@untitledui/icons`, Bun test runner. No new dependencies.

**Spec:** `specs/2026-05-13-decopilot-collapsible-highlights-design.md`

---

## Task 1: Create the `CollapsibleHighlight` shell

The disclosure component every banner will compose. Pure presentation — owns one piece of `useState`, no effects.

**Files:**
- Create: `apps/mesh/src/web/components/chat/highlight/collapsible-highlight.tsx`

- [ ] **Step 1: Create the file**

Write `apps/mesh/src/web/components/chat/highlight/collapsible-highlight.tsx`:

```tsx
/**
 * CollapsibleHighlight — the shared shell for every banner in the chat
 * highlight slot (todos, question, plan, approval, error, warning).
 *
 * One always-visible chip row (icon + label + optional count + caret),
 * one expandable body containing the substantive content (form fields,
 * plan markdown, todo list, etc.), and an optional footer row.
 *
 * Open/close state is local. Each banner instance gets its own state;
 * the parent passes a stable `key` so React remounts on identity change
 * (a new question, a new approval batch, a new plan) and the new instance
 * starts at `defaultExpanded`. Stable identity = stable state across
 * re-renders.
 *
 * The body is rendered into the DOM unconditionally and hidden via the
 * `hidden` attribute when collapsed. This preserves form state, scroll
 * position, and selected tab across collapse/expand cycles.
 */

import { useState, type ReactNode } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { ChevronDown, ChevronUp } from "@untitledui/icons";

export type HighlightVariant = "default" | "error" | "warning";

export interface CollapsibleHighlightProps {
  /** Small icon shown at the left of the chip row (~14px). */
  icon: ReactNode;
  /** One short phrase summarizing the banner, e.g. "Question pending". */
  label: string;
  /** Optional right-aligned count, e.g. "1 of 3" or "3 pending". */
  count?: string | null;
  /** Heading shown inside the expanded body. */
  title?: string | null;
  /** Footer-left content (e.g. <Pagination />). */
  footerLeft?: ReactNode;
  /** Footer-right content (action buttons). */
  footerRight?: ReactNode;
  /** Body content. */
  children?: ReactNode;
  /** Initial open state on first mount. */
  defaultExpanded: boolean;
  /** Drives translucent overlay for status banners. */
  variant?: HighlightVariant;
}

const VARIANT_OVERLAY: Record<HighlightVariant, string> = {
  default: "",
  error: "bg-destructive/5",
  warning: "bg-amber-500/5",
};

const VARIANT_BORDER: Record<HighlightVariant, string> = {
  default: "border-border",
  error: "border-destructive/30",
  warning: "border-amber-500/30",
};

const VARIANT_ICON_COLOR: Record<HighlightVariant, string> = {
  default: "text-muted-foreground",
  error: "text-destructive",
  warning: "text-amber-600 dark:text-amber-500",
};

export function CollapsibleHighlight({
  icon,
  label,
  count,
  title,
  footerLeft,
  footerRight,
  children,
  defaultExpanded,
  variant = "default",
}: CollapsibleHighlightProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div
      data-testid="collapsible-highlight"
      data-variant={variant}
      className={cn(
        "flex flex-col rounded-xl bg-background border shadow-md",
        "w-[calc(100%-16px)] max-w-[584px] mx-auto mb-2",
        VARIANT_BORDER[variant],
        VARIANT_OVERLAY[variant],
      )}
    >
      <button
        type="button"
        data-testid="collapsible-highlight-chip"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className={cn(
          "flex items-center gap-2 w-full px-3 py-2 text-sm text-left",
          "hover:bg-accent/50 transition-colors rounded-t-xl",
          expanded && "rounded-b-none",
          !expanded && "rounded-b-xl",
        )}
      >
        <span className={cn("shrink-0", VARIANT_ICON_COLOR[variant])}>
          {icon}
        </span>
        <span className="flex-1 min-w-0 truncate">{label}</span>
        {count ? (
          <span className="text-xs text-muted-foreground shrink-0">
            {count}
          </span>
        ) : null}
        <span aria-hidden="true" className="text-muted-foreground shrink-0">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      <div hidden={!expanded} data-testid="collapsible-highlight-body">
        {title ? (
          <div className="flex items-center gap-2 px-4 pt-3 pb-1 border-t border-dashed border-border/60">
            <p className="flex-1 text-base font-medium text-foreground min-w-0">
              {title}
            </p>
          </div>
        ) : (
          <div className="border-t border-dashed border-border/60" />
        )}

        {children ? <div className="overflow-clip pb-4 pt-2">{children}</div> : null}

        {footerLeft || footerRight ? (
          <div className="border-t border-border px-3 py-3 pb-6">
            <div className="flex items-center justify-between">
              <div>{footerLeft}</div>
              <div className="flex items-center gap-2">{footerRight}</div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```
bun run check
```

Expected: PASS. (`ChevronDown` / `ChevronUp` are confirmed exports of `@untitledui/icons` — already used elsewhere.)

- [ ] **Step 3: Lint**

```
bun run lint
```

Expected: PASS. No `useEffect` introduced, so no exception comment needed.

- [ ] **Step 4: Format and commit**

```
bun run fmt
git add apps/mesh/src/web/components/chat/highlight/collapsible-highlight.tsx
git commit -m "feat(decopilot): add CollapsibleHighlight shared shell"
```

---

## Task 2: Migrate `TodosHighlight` to use the shell

The simplest banner — establishes the migration pattern. Drops the bespoke dashed-border card, drops `bannerActive` and its `useEffect`.

**Files:**
- Modify: `apps/mesh/src/web/components/chat/highlight/todos.tsx`

- [ ] **Step 1: Rewrite `todos.tsx`**

Replace the entire contents of `apps/mesh/src/web/components/chat/highlight/todos.tsx` with:

```tsx
/**
 * TodosHighlight — collapsed chip + expanded list for the per-thread todo
 * list maintained by the model via `todo_write`.
 *
 * Reads the same UIMessage stream the chat renders; no API call of its
 * own. Renders nothing when the list is empty.
 *
 * Defaults to collapsed (only banner that does) — todos are passive
 * status, not an active prompt. Wraps `CollapsibleHighlight` so the
 * chip + body share a single card with consistent chrome.
 */

import { cn } from "@deco/ui/lib/utils.ts";
import type { Todo } from "@/api/routes/decopilot/built-in-tools/todo-write";
import { getCurrentTodos } from "@/api/routes/decopilot/current-todos";
import { useChatStream } from "../context";
import { CollapsibleHighlight } from "./collapsible-highlight";
import { type ChipIcon, deriveChipLabel } from "./derive-chip-label";

export function TodosHighlight() {
  const { messages } = useChatStream();
  const todos = getCurrentTodos(messages);
  if (todos.length === 0) return null;

  const label = deriveChipLabel(todos);

  return (
    <CollapsibleHighlight
      icon={<StatusMark status={label.icon} />}
      label={label.activity}
      count={label.progress}
      defaultExpanded={false}
    >
      <ul
        data-testid="todos-list"
        className="flex flex-col gap-1.5 px-4 max-h-[40vh] overflow-y-auto"
      >
        {/* key=i is safe: todo_write rewrites the full list atomically; no stable id exists */}
        {todos.map((todo, i) => (
          <TodoRow key={i} todo={todo} />
        ))}
      </ul>
    </CollapsibleHighlight>
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

function StatusMark({ status }: { status: ChipIcon }) {
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

Key differences vs. the previous version:
- `bannerActive` prop is removed. The function signature is now `TodosHighlight()` with no props.
- The `useEffect` that previously cleared `expanded` on banner-fire is gone.
- The bespoke dashed-border outer card is gone — `CollapsibleHighlight` owns the chrome.
- `defaultExpanded={false}` preserves the previous default-collapsed behavior.

- [ ] **Step 2: Update the import in `ChatHighlight`**

Open `apps/mesh/src/web/components/chat/highlight/index.tsx` and find the JSX:

```tsx
<TodosHighlight bannerActive={bannerNode !== null} />
```

Change it to:

```tsx
<TodosHighlight />
```

(`bannerNode !== null` becomes irrelevant under the new shell; we'll do the bigger ChatHighlight refactor in Task 7. This minimal edit keeps the file compiling between tasks.)

- [ ] **Step 3: Type-check and lint**

```
bun run check
bun run lint
```

Both must PASS.

- [ ] **Step 4: Run the existing tests**

```
bun test apps/mesh/src/web/components/chat/highlight/derive-chip-label.test.ts
```

Expected: PASS, 6/6. The pure helper is unchanged; this confirms the change didn't break compilation of the helper's importers.

- [ ] **Step 5: Format and commit**

```
bun run fmt
git add apps/mesh/src/web/components/chat/highlight/todos.tsx \
        apps/mesh/src/web/components/chat/highlight/index.tsx
git commit -m "refactor(decopilot): migrate TodosHighlight onto CollapsibleHighlight"
```

---

## Task 3: Migrate `StatusHighlight` (error / warning) to use the shell

`StatusHighlight` lives inside `index.tsx`. Migrating it exercises the `variant` prop and proves the translucent-overlay flow before tackling the larger banners.

**Files:**
- Modify: `apps/mesh/src/web/components/chat/highlight/index.tsx`

- [ ] **Step 1: Replace the `StatusHighlight` component**

Open `apps/mesh/src/web/components/chat/highlight/index.tsx`. Find the `StatusHighlight` function (currently near the top of the file). Replace its entire body with:

```tsx
function StatusHighlight(props: StatusHighlightProps) {
  const { variant, onDismiss } = props;
  const isError = variant === "error";

  const label = isError ? "Error occurred" : "Response incomplete";
  const message = isError
    ? props.error.message
    : (WARNING_DESCRIPTIONS[props.finishReason] ??
      `Response stopped unexpectedly: ${props.finishReason}`);
  const Icon = isError ? AlertCircle : AlertTriangle;

  return (
    <CollapsibleHighlight
      icon={<Icon size={14} />}
      label={label}
      title={message}
      defaultExpanded={true}
      variant={variant}
      footerRight={
        <>
          {isError ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={props.onFixInChat}
                className="h-7 text-xs"
              >
                Fix in chat
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled
                className="h-7 text-xs"
              >
                Report
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={props.onContinue}
              className="h-7 text-xs"
            >
              Continue
            </Button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0 ml-1"
            title="Dismiss"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </>
      }
    >
      {null}
    </CollapsibleHighlight>
  );
}
```

(The error/warning body has no substantive content — the message lives in the chip label's `title`. The Dismiss `X` button moves into `footerRight` since the shell no longer has the original card's top-right slot.)

- [ ] **Step 2: Add the import**

Near the top of `index.tsx`, add:

```tsx
import { CollapsibleHighlight } from "./collapsible-highlight";
```

(Place it alongside the other `./` imports.)

- [ ] **Step 3: Type-check and lint**

```
bun run check
bun run lint
```

Both must PASS. (TypeScript will complain about the changed shape — the `StatusHighlight` previously returned a `<div className="px-0.5">...</div>` wrapper; the new version returns `<CollapsibleHighlight>` directly. Verify no caller of `StatusHighlight` depends on the previous wrapper.)

- [ ] **Step 4: Format and commit**

```
bun run fmt
git add apps/mesh/src/web/components/chat/highlight/index.tsx
git commit -m "refactor(decopilot): migrate StatusHighlight onto CollapsibleHighlight"
```

---

## Task 4: Migrate `ProposePlanHighlight` to use the shell

Single-instance banner, no inner pagination, plan markdown lives in the body.

**Files:**
- Modify: `apps/mesh/src/web/components/chat/highlight/propose-plan.tsx`

- [ ] **Step 1: Read the current file to confirm shape**

```
cat apps/mesh/src/web/components/chat/highlight/propose-plan.tsx
```

Note the prop shape of `ProposePlanHighlight` (the export consumed by `ChatHighlight`) and the inner `ProposePlanPrompt` that currently wraps content in `HighlightCard`. We're replacing only the `HighlightCard` usage; the prop shape stays.

- [ ] **Step 2: Replace `HighlightCard` with `CollapsibleHighlight`**

In `apps/mesh/src/web/components/chat/highlight/propose-plan.tsx`:

Change the import line:
```tsx
import { HighlightCard } from "./card";
```
to:
```tsx
import { CollapsibleHighlight } from "./collapsible-highlight";
import { ClipboardCheck } from "@untitledui/icons";
```

(`ClipboardCheck` is confirmed available in `@untitledui/icons`.)

Then find the JSX inside `ProposePlanPrompt` that uses `HighlightCard`:

```tsx
<HighlightCard
  title="…"
  footerRight={…}
>
  <MessageTextPart … />
</HighlightCard>
```

(The exact title and footerRight are already present in the file. Don't change them — just wrap differently.)

Replace with:

```tsx
<CollapsibleHighlight
  icon={<ClipboardCheck size={14} />}
  label="Plan ready"
  title="Proposed plan"
  defaultExpanded={true}
  footerRight={/* existing footerRight value, unchanged */}
>
  {/* existing children, unchanged */}
</CollapsibleHighlight>
```

Keep the existing `footerRight` content (Approve/Dismiss buttons) and the existing body (`<MessageTextPart text={plan.plan} />`).

- [ ] **Step 3: Type-check, lint**

```
bun run check
bun run lint
```

Both must PASS.

- [ ] **Step 4: Format and commit**

```
bun run fmt
git add apps/mesh/src/web/components/chat/highlight/propose-plan.tsx
git commit -m "refactor(decopilot): migrate ProposePlanHighlight onto CollapsibleHighlight"
```

---

## Task 5: Migrate `ApprovalHighlight` to use the shell

Multi-instance banner — `approvals.length` drives the chip label; `Pagination` lives in `footerLeft`.

**Files:**
- Modify: `apps/mesh/src/web/components/chat/highlight/approval.tsx`

- [ ] **Step 1: Read the current file**

```
cat apps/mesh/src/web/components/chat/highlight/approval.tsx
```

Note where `HighlightCard` is used inside the component that renders one or more approvals. There may be both single-instance and tabbed multi-instance paths — both move to `CollapsibleHighlight`.

- [ ] **Step 2: Swap the import**

Replace:
```tsx
import { HighlightCard, Pagination } from "./card";
```
with:
```tsx
import { Pagination } from "./card";
import { CollapsibleHighlight } from "./collapsible-highlight";
```

- [ ] **Step 3: Replace each `<HighlightCard …>` usage**

For each `<HighlightCard …>` block, change to:

```tsx
<CollapsibleHighlight
  icon={<ShieldTick size={14} />}
  label={approvals.length === 1 ? "Approval needed" : `${approvals.length} approvals pending`}
  title={/* existing title value, unchanged */}
  defaultExpanded={true}
  footerLeft={/* existing footerLeft (Pagination) value, unchanged */}
  footerRight={/* existing footerRight value, unchanged */}
>
  {/* existing children, unchanged */}
</CollapsibleHighlight>
```

Notes:
- `ShieldTick` is already imported in this file.
- The chip `label` is derived from `approvals.length` — when only one approval is pending the chip reads "Approval needed"; when multiple, "N approvals pending". Compute this value once in the component and pass it as `label`.
- `count` is not set (the chip label already communicates the count for the multi case).
- Single-instance and multi-tabbed paths use the same `label` formula.

- [ ] **Step 4: Type-check and lint**

```
bun run check
bun run lint
```

Both must PASS.

- [ ] **Step 5: Format and commit**

```
bun run fmt
git add apps/mesh/src/web/components/chat/highlight/approval.tsx
git commit -m "refactor(decopilot): migrate ApprovalHighlight onto CollapsibleHighlight"
```

---

## Task 6: Migrate `UserAskQuestionHighlight` to use the shell

The most intricate banner — has both single-question and multi-question (tabbed) paths. The chip's `count` is computed from `activeTab` / `parts` and updates as the user navigates pagination.

**Files:**
- Modify: `apps/mesh/src/web/components/chat/highlight/user-ask-question.tsx`

- [ ] **Step 1: Read the current file to refresh on its structure**

```
sed -n '1,50p' apps/mesh/src/web/components/chat/highlight/user-ask-question.tsx
sed -n '420,520p' apps/mesh/src/web/components/chat/highlight/user-ask-question.tsx
```

The relevant section is around `UserAskPrompt` near the bottom. It has two render branches: single-question (`parts.length === 1`) and multi-question (with `Tabs`). Both wrap content in `HighlightCard`.

- [ ] **Step 2: Swap the import**

Replace:
```tsx
import { HighlightCard, Pagination } from "./card";
```
with:
```tsx
import { Pagination } from "./card";
import { CollapsibleHighlight } from "./collapsible-highlight";
```

- [ ] **Step 3: Replace the single-question path**

Find the single-question `if` block (around line 427 currently — verify by reading the file). It returns a `<HighlightCard title={part.input?.prompt ?? "Question"} footerRight={footerButtons}>...</HighlightCard>`. Change to:

```tsx
  // Single question — no tabs needed
  if (parts.length === 1) {
    const part = parts[0];
    if (!part?.input) return null;

    return (
      <Form {...form}>
        <form onSubmit={form.handleSubmit(submitAll)} autoComplete="off">
          <CollapsibleHighlight
            icon={<MessageQuestionCircle size={14} />}
            label="Question pending"
            title={part.input?.prompt ?? "Question"}
            defaultExpanded={true}
            footerRight={footerButtons}
          >
            <QuestionInput
              input={part.input as UserAskInput}
              control={form.control}
              name={`${part.toolCallId}.response`}
            />
          </CollapsibleHighlight>
        </form>
      </Form>
    );
  }
```

- [ ] **Step 4: Replace the multi-question path**

The multi-question render returns `<Tabs>` containing `<TabsContent>`s, each with `<HighlightCard>`. The chip's `count` needs to reflect the *active* tab's position. Restructure so `CollapsibleHighlight` is OUTSIDE `Tabs` (only one chip, regardless of which tab is active), and the `TabsContent` is the body:

```tsx
  // Multiple questions — tabbed layout with one outer collapsible
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submitAll)} autoComplete="off">
        <CollapsibleHighlight
          icon={<MessageQuestionCircle size={14} />}
          label="Question pending"
          count={`${currentIndex + 1} of ${parts.length}`}
          title={parts[currentIndex]?.input?.prompt ?? "Question"}
          defaultExpanded={true}
          footerLeft={pagination}
          footerRight={footerButtons}
        >
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            {parts.map((part) => (
              <TabsContent
                key={part.toolCallId}
                value={part.toolCallId}
                className="mt-0"
              >
                <QuestionInput
                  input={part.input as UserAskInput}
                  control={form.control}
                  name={`${part.toolCallId}.response`}
                />
              </TabsContent>
            ))}
          </Tabs>
        </CollapsibleHighlight>
      </form>
    </Form>
  );
```

Key changes:
- `Tabs` moves inside the shell's body (was outside, with one `HighlightCard` per tab).
- `count` is `"{currentIndex + 1} of {parts.length}"`.
- `title` reads the active part's prompt (`parts[currentIndex]?.input?.prompt`).

- [ ] **Step 5: Type-check and lint**

```
bun run check
bun run lint
```

Both must PASS. (TypeScript may not narrow `parts[currentIndex]` to non-undefined; use optional chaining as shown.)

- [ ] **Step 6: Format and commit**

```
bun run fmt
git add apps/mesh/src/web/components/chat/highlight/user-ask-question.tsx
git commit -m "refactor(decopilot): migrate UserAskQuestionHighlight onto CollapsibleHighlight"
```

---

## Task 7: `ChatHighlight` concurrent rendering + delete `HighlightCard`

Flatten the priority cascade. Each banner's condition is evaluated independently; all that apply render. Remove the `bannerNode` ternary, `bannerNeedsBg` flag, and the `HighlightCard` export now that all callers have moved.

**Files:**
- Modify: `apps/mesh/src/web/components/chat/highlight/index.tsx`
- Modify: `apps/mesh/src/web/components/chat/highlight/card.tsx`

- [ ] **Step 1: Refactor `ChatHighlight` to concurrent rendering**

Open `apps/mesh/src/web/components/chat/highlight/index.tsx`. Find the body of `ChatHighlight` from the comment `// Priority: ...` down through the final `return (...)`. Replace that whole block with:

```tsx
  // Each banner condition is evaluated independently; all that match
  // render. Stack order is severity-descending — the last child sits
  // closest to the chat input. Credit-exhausted errors are a modal,
  // handled by an early return outside the stack.

  if (!isStreaming && error && isCreditError(error)) {
    return <CreditsExhaustedBanner onDismiss={clearError} />;
  }

  const todosVisible = getCurrentTodos(messages).length > 0;
  const showError = !isStreaming && !!error;
  const showWarning =
    !isStreaming &&
    !!finishReason &&
    finishReason !== "stop" &&
    !isWaitingForApprovals &&
    !showError;
  const hasApprovals =
    pendingApprovals.length > 0 || (isStreaming && isWaitingForApprovals);
  const userAskKey = userAskParts?.map((p) => p.toolCallId).join("|") ?? "";
  const planKey = pendingPlans[0]?.toolCallId ?? "";
  const approvalKey = pendingApprovals.map((a) => a.approvalId).join("|");

  return (
    <div className="absolute bottom-full left-0 right-0">
      {todosVisible && <TodosHighlight />}
      {showError && (
        <StatusHighlight
          variant="error"
          error={error as Error}
          onDismiss={clearError}
          onFixInChat={handleFixInChat}
        />
      )}
      {showWarning && (
        <StatusHighlight
          variant="warning"
          finishReason={finishReason as string}
          onDismiss={clearFinishReason}
          onContinue={handleContinue}
        />
      )}
      {hasApprovals && (
        <ApprovalHighlight
          key={approvalKey}
          approvals={pendingApprovals}
          isStreaming={isStreaming}
          onRespond={handleApprovalRespond}
        />
      )}
      {pendingPlans.length > 0 && (
        <ProposePlanHighlight
          key={planKey}
          plans={pendingPlans}
          isStreaming={isStreaming}
          onApprove={handlePlanApprove}
          onDismiss={handlePlanDismiss}
        />
      )}
      {isWaitingForUserInput && userAskParts && (
        <UserAskQuestionHighlight
          key={userAskKey}
          userAskParts={userAskParts}
          isStreaming={isStreaming}
          onSubmit={handleUserAskSubmit}
        />
      )}
    </div>
  );
}
```

What's removed:
- The whole `let bannerNode … if/else if …` chain
- `let bannerNeedsBg = false` and its references
- The `cn(..., bannerNeedsBg && "bg-background")` on the wrapper

What stays as-is:
- The hooks at the top of `ChatHighlight` (`useChatStream`, `usePreferences`, `useChatTask`)
- All the handler functions (`handleFixInChat`, `handleContinue`, `handleUserAskSubmit`, `handlePlanApprove`, `handlePlanDismiss`, `handleApprovalRespond`)
- The static sub-component attachments at the bottom of the file (`ChatHighlight.Error`, `ChatHighlight.Warning`, `ChatHighlight.UserAskQuestion`)
- The credit-error early return

- [ ] **Step 2: Type-check the new shape**

```
bun run check
```

Expected: PASS. Resolve any narrowing complaints inline. The `error as Error` and `finishReason as string` casts are explicit because the conditions above guarantee they're set; the type system can't always narrow that. If `bun run check` flags `userAskParts` as possibly null at the JSX site, use the `isWaitingForUserInput && userAskParts && (…)` pattern shown above (already in the snippet).

- [ ] **Step 3: Delete `HighlightCard`**

Open `apps/mesh/src/web/components/chat/highlight/card.tsx`. Remove the `HighlightCard` function, its `HighlightCardProps` interface, and the section header comment. Keep `Pagination` and `PaginationProps`.

After the edit, the file should contain only the `Pagination` export plus its imports.

- [ ] **Step 4: Type-check again**

```
bun run check
```

Expected: PASS. If any file still imports `HighlightCard`, it will fail compilation — fix by ensuring all banner migrations (Tasks 3–6) imported `CollapsibleHighlight` instead. If something is missed, that file needs its import updated.

- [ ] **Step 5: Lint**

```
bun run lint
```

Expected: PASS.

- [ ] **Step 6: Smoke-check via dev server**

```
bun run dev
```

Wait for "ready" output from Vite + the Hono server. Verify the server boots without crashing on the new imports. Stop with Ctrl-C.

If `bun run dev` fails to boot for environmental reasons (port conflict, missing Docker, missing `.env`), document the failure but don't treat it as a Task 7 blocker — note and skip to commit.

- [ ] **Step 7: Format and commit**

```
bun run fmt
git add apps/mesh/src/web/components/chat/highlight/index.tsx \
        apps/mesh/src/web/components/chat/highlight/card.tsx
git commit -m "refactor(decopilot): render chat highlights concurrently; drop HighlightCard"
```

---

## Task 8: Final verification (automated + manual smoke)

Controller-driven. Automated steps run before declaring done; smoke is a checklist for the user (or the controller via chrome-devtool).

- [ ] **Step 1: Full automated suite**

```
bun run check
bun run lint
bun run fmt:check
bun test apps/mesh/src/web/components/chat/highlight/derive-chip-label.test.ts
```

All four must PASS clean.

- [ ] **Step 2: Boot dev server and verify URL loads**

```
bun run dev
```

Then verify the project URL loads without console errors. Stop the server when done.

- [ ] **Step 3: Manual smoke checklist (executed in the browser)**

Open a thread with the agent and verify:

1. **Question banner — default expanded:** ask the agent something that triggers a `user_ask` tool call. Chip reads `❓ Question pending` and body is expanded by default. Click chip to collapse → body hides, chip stays. Click chip to re-expand. Type into a text field, click chip to collapse, click to re-expand — typed text is preserved (validates `hidden` mount strategy).

2. **Multi-question:** force 3 `user_ask` calls. Chip reads `❓ Question pending · 1 of 3`. Click Pagination → count updates `2 of 3`. Click chip to collapse, click to re-expand → still on question 2. Form state for all 3 questions preserved across collapse.

3. **Error + question concurrent:** trigger a tool error in one turn; in the next turn the agent asks a question. Both banners render: question card at bottom (closest to input), error card above it. Each individually collapsible. Dismiss error → it vanishes, question stays.

4. **Todos + interactive banner:** in a thread with active todos, trigger a question. Three things stack top-to-bottom: question (closest to input) → todos chip (top). Todos chip defaults collapsed; question defaults expanded.

5. **Plan + approval coexistence:** if the agent emits a propose-plan AND has pending approvals (rare but possible), both render. Verify stacking matches the design: approval above plan above question, todos at the top.

6. **Warning banner:** trigger a `finishReason` that's not `"stop"` (e.g., hit the model's output token limit). Warning banner renders with amber tint, "Continue" button in footer.

7. **Credit-exhausted error:** force a credit error. `CreditsExhaustedBanner` modal renders OUTSIDE the stack (full-screen modal) — verify other banners are NOT rendered concurrently with it.

8. **Resolve flow:** answer a question → its chip vanishes. Approve a plan → vanishes. Dismiss an error → vanishes. Todos chip persists.

- [ ] **Step 4: If smoke surfaces issues**

Document the specific issue and route to a fix:
- If a banner won't collapse → inspect the `CollapsibleHighlight` chip click handler in the DOM.
- If form state is lost on collapse → confirm `hidden={!expanded}` is in use (not conditional render).
- If banners render in the wrong stack order → check the JSX order in `ChatHighlight`'s return (top of JSX = top of slot = farthest from input).
- If a chip's label/count is wrong → check the per-banner adapter (Tasks 3–6 prescribe the formulas).

- [ ] **Step 5: Stop dev server, final commit if any drift**

```
bun run fmt
git status
# If anything changed: git add -A && git commit -m "[chore]: format"
```

If `git status` is clean, you're done.

---

## Spec coverage check

| Spec section | Implemented in |
|---|---|
| Decision 1 (every highlight collapsible) | Tasks 2–6 |
| Decision 2 (mixed defaults) | Tasks 2–6 (each banner sets `defaultExpanded`) |
| Decision 3 (generic label + count) | Tasks 3–6 (per-banner adapter) |
| Decision 4 (unified visual style) | Task 1 (`CollapsibleHighlight` chrome) |
| Decision 5 (state preserved via `hidden`) | Task 1 (`<div hidden={!expanded}>`) |
| Decision 6 (per-instance keying) | Task 7 (keys on banner JSX) |
| Decision 7 (concurrent rendering, severity-descending stack) | Task 7 (independent conditionals, JSX order) |
| `bannerNeedsBg` removal | Task 7 |
| `HighlightCard` deletion | Task 7 |
| `bannerActive` prop removal from todos | Task 2 |
| Variant-driven overlay (error/warning) | Tasks 1 + 3 |
| Pagination remains | Task 5, 6 (still imported from `card.tsx`) |
| Credit-exhausted modal stays separate | Task 7 (early return preserved) |
| Manual smoke | Task 8 |

Every spec decision maps to a task. Stacking order, keying, state preservation, and concurrent rendering all land in Task 7.

# Decopilot collapsible highlights — unified shell + concurrent rendering

**Date:** 2026-05-13
**Status:** Design — pending plan
**Related:**
- `specs/2026-05-13-decopilot-todos-highlight-ui-design.md` (todos chip — basis for the shell)
- `specs/2026-05-12-decopilot-todo-write-design.md` (introduced `todo_write`)

## Problem

The chat highlight slot above the input today has two problems:

1. **Mutually exclusive priority** — `ChatHighlight` runs an `if/else if` cascade across five banner conditions. Only one banner can show at a time. If an error is unread and a new question fires, the error is hidden until the question resolves. Practical scenario: pre-existing error + new pending question is normal during an active conversation, and the user only sees one of them.

2. **Two visual languages** — interactive banners (question, plan, approval) use `HighlightCard` (solid border, centered, max-w-584px). The recently-shipped todos chip uses its own dashed-border full-width card. No collapse affordance on the interactive banners — they always occupy substantial vertical space above the input, blocking the user from scrolling chat history while a prompt is pending.

## Goal

Unify all chat-highlight banners onto **one collapsible shell** (`CollapsibleHighlight`) and **render concurrently** when multiple conditions apply. Each banner becomes a thin adapter that supplies chip-content and body-content; the shell owns the open/close behavior and visual chrome.

Net user-visible result:
- Any highlight (todos, question, plan, approval, error, warning) can be collapsed to a one-line chip to free vertical space.
- Multiple highlights stack instead of suppressing each other.
- Visual language is consistent across the family.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Every highlight is collapsible — todos, question, plan, approval, error, warning | Same screen-real-estate need applies across all banner types |
| 2 | Default expansion is mixed: todos collapsed; interactive prompts + status banners expanded | Active prompts shouldn't be hidden behind a chip (discoverability); todos is passive status |
| 3 | Collapsed chip shows a generic label per banner type; count appended right when multiple instances exist | Predictable, doesn't depend on whatever prompt text the model emits |
| 4 | Unify on the existing `HighlightCard` visual style (solid border, rounded-xl, centered max-w-[584px]) for ALL banners including todos | The intentional "focused interaction surface" presentation generalizes; todos is the smaller adjustment |
| 5 | State across collapse/expand is **fully preserved** (typed text, selected choice, scroll position, tab) via `hidden` attribute (keep DOM mounted) | The whole motivating use case is "collapse to read context, come back to finish" — losing state on collapse is user-hostile |
| 6 | Each banner instance gets a fresh `defaultExpanded` state when its identity changes; identity is communicated via React `key` | New blocking signal = should be visible; same instance across re-renders = state preserved |
| 7 | Concurrent rendering: each banner condition independently evaluated; all that match render. Stack order = severity descending (last = closest to input) | Most-actionable thing closest to the input; ambient/status things higher in the stack |

## Architecture

### Stacking order (top → bottom of the slot, last = closest to chat input)

```
┌─ TodosHighlight ─────────────┐    background status (default collapsed)
├─ StatusHighlight (error)     ┤    info status (default expanded, variant="error")
├─ StatusHighlight (warning)   ┤    info status (default expanded, variant="warning")
├─ ApprovalHighlight ──────────┤    interactive (default expanded)
├─ ProposePlanHighlight ───────┤    interactive (default expanded)
├─ UserAskQuestionHighlight ───┤    interactive (default expanded) — closest to input
└──────────────────────────────┘
[ chat input ──────────────────]
```

In practice 0–3 banners stack at once. Error and warning are mutually exclusive in conditions (warning suppressed when error active), so at most one of those rows shows.

### File plan

**New**
- `apps/mesh/src/web/components/chat/highlight/collapsible-highlight.tsx` — the shared shell + its types

**Modified**
- `apps/mesh/src/web/components/chat/highlight/user-ask-question.tsx` — replace `HighlightCard` wrapping with `CollapsibleHighlight`; lift active-question pagination into the chip `count`
- `apps/mesh/src/web/components/chat/highlight/propose-plan.tsx` — same pattern, single-instance
- `apps/mesh/src/web/components/chat/highlight/approval.tsx` — same pattern; chip label varies on `approvals.length`
- `apps/mesh/src/web/components/chat/highlight/todos.tsx` — replace bespoke dashed-chip with `CollapsibleHighlight`; **delete** `bannerActive` prop + the associated `useEffect`
- `apps/mesh/src/web/components/chat/highlight/index.tsx` — flatten priority cascade to independent conditionals; delete `bannerNode`, `bannerNeedsBg`; migrate `StatusHighlight` to `CollapsibleHighlight` with `variant`
- `apps/mesh/src/web/components/chat/highlight/card.tsx` — delete `HighlightCard` export; keep `Pagination`

**Unchanged**
- `apps/mesh/src/web/components/chat/highlight/derive-chip-label.ts` (+ test) — still produces the chip text for todos
- `CreditsExhaustedBanner` (separate file, modal — early-returns outside the banner stack)

### Component contract — `CollapsibleHighlight`

```ts
interface CollapsibleHighlightProps {
  // Chip content (always visible)
  icon: ReactNode;            // small icon, ~14px
  label: string;              // one short phrase, e.g. "Question pending"
  count?: string | null;      // pinned right, optional — e.g. "1 of 3", "3 pending"

  // Body content (visible when expanded)
  title?: string;             // heading inside body, e.g. the question prompt
  footerLeft?: ReactNode;     // e.g. <Pagination />
  footerRight?: ReactNode;    // action buttons
  children: ReactNode;        // the substantive content

  // Behavior
  defaultExpanded: boolean;   // true for active prompts + status; false for todos
  variant?: "default" | "error" | "warning";  // drives translucent overlay
}
```

Internals:
- Single `useState<boolean>(defaultExpanded)`. No `useEffect`.
- Body wrapped in `<div hidden={!expanded}>` — DOM stays mounted; CSS `display: none` via the `hidden` attribute preserves form state and scroll position while removing the element from the a11y tree.
- Chip is a `<button aria-expanded={expanded}>` toggling state.
- Shell: `rounded-xl border bg-background shadow-md w-[calc(100%-16px)] max-w-[584px] mx-auto mb-2`.
- For `variant="error"`/`"warning"`, the chip row + body get the translucent overlay (`bg-destructive/5` / `bg-amber-500/5`); the shell's own `bg-background` is the opaque backdrop.
- Identity / fresh-state-per-instance — the **parent** passes a stable `key` prop. When the key changes, React remounts the component and `defaultExpanded` is honored. When the key is stable, state is preserved.

### Per-banner adaptation

#### `user-ask-question.tsx`

Wrap the existing `QuestionInput` body + footer in `CollapsibleHighlight`. The `Tabs` indirection for multi-question stays internal; the chip's `count` is computed from `activeTab`/`parts` and passed in.

```tsx
const single = parts.length === 1;
<CollapsibleHighlight
  icon={<MessageQuestionCircle size={14} />}
  label="Question pending"
  count={single ? null : `${currentIndex + 1} of ${parts.length}`}
  title={part.input?.prompt ?? "Question"}
  footerLeft={!single ? <Pagination … /> : null}
  footerRight={<>{SkipButton}{NextOrSubmitButton}</>}
  defaultExpanded={true}
>
  <QuestionInput … />
</CollapsibleHighlight>
```

`UserAskLoadingUI` (streaming) keeps its own rendering — no collapse mode needed during the loading state.

#### `propose-plan.tsx`

```tsx
<CollapsibleHighlight
  icon={<ClipboardCheck size={14} />}
  label="Plan ready"
  title="Proposed plan"
  footerRight={<>{ApproveButton}{DismissButton}</>}
  defaultExpanded={true}
>
  <MessageTextPart text={plan.plan} />
</CollapsibleHighlight>
```

#### `approval.tsx`

```tsx
<CollapsibleHighlight
  icon={<ShieldTick size={14} />}
  label={approvals.length === 1 ? "Approval needed" : `${approvals.length} approvals pending`}
  title={currentApproval.friendlyName}
  footerLeft={<Pagination … />}
  footerRight={<>{RejectButton}{ApproveButton}{ApprovalLevelSelect}</>}
  defaultExpanded={true}
>
  {/* existing approval body */}
</CollapsibleHighlight>
```

#### `index.tsx` — `StatusHighlight`

```tsx
<CollapsibleHighlight
  icon={isError ? <AlertCircle size={14} /> : <AlertTriangle size={14} />}
  label={isError ? "Error occurred" : "Response incomplete"}
  title={isError ? props.error.message : description}
  footerRight={isError ? <>{FixInChatButton}{ReportButton}</> : <>{ContinueButton}</>}
  defaultExpanded={true}
  variant={isError ? "error" : "warning"}
>
  {/* body may be empty — title carries the message */}
</CollapsibleHighlight>
```

#### `todos.tsx`

```tsx
<CollapsibleHighlight
  icon={<StatusMark status={label.icon} />}
  label={label.activity}
  count={label.progress}
  defaultExpanded={false}
>
  <ul …>{todos.map(...)}</ul>
</CollapsibleHighlight>
```

Delete the bespoke dashed-border wrapper. Delete the `bannerActive` prop. Delete the `useEffect` that previously cleared `expanded` on banner-fire.

### `ChatHighlight` — concurrent rendering

```tsx
export function ChatHighlight() {
  // … existing hooks & handlers …

  // Credit-exhausted is a modal — early return, outside the stack.
  if (!isStreaming && error && isCreditError(error)) {
    return <CreditsExhaustedBanner onDismiss={clearError} />;
  }

  const todosVisible = getCurrentTodos(messages).length > 0;
  const pendingUserAsks = (lastMessage?.role === "assistant" ? lastMessage.parts : [])
    .filter(p => p.type === "tool-user_ask" && p.state !== "output-available");
  const pendingPlansList = lastMessage?.role === "assistant"
    ? extractPendingPlans(lastMessage.parts) : [];
  const pendingApprovalsList = lastMessage?.role === "assistant"
    ? extractPendingApprovals(lastMessage.parts as …) : [];
  const hasApprovals =
    pendingApprovalsList.length > 0 || (isStreaming && isWaitingForApprovals);
  const showError = !isStreaming && !!error;   // credit case already returned
  const showWarning = !isStreaming && !!finishReason && finishReason !== "stop"
                      && !isWaitingForApprovals && !showError;

  return (
    <div className="absolute bottom-full left-0 right-0">
      {/* Severity descending — last child = closest to input. */}
      {todosVisible && <TodosHighlight />}
      {showError   && <StatusHighlight variant="error"   error={error} onDismiss={clearError} onFixInChat={handleFixInChat} />}
      {showWarning && <StatusHighlight variant="warning" finishReason={finishReason} onDismiss={clearFinishReason} onContinue={handleContinue} />}
      {hasApprovals && (
        <ApprovalHighlight
          key={pendingApprovalsList.map(a => a.approvalId).join("|")}
          approvals={pendingApprovalsList}
          isStreaming={isStreaming}
          onRespond={handleApprovalRespond}
        />
      )}
      {pendingPlansList.length > 0 && (
        <ProposePlanHighlight
          key={pendingPlansList[0].toolCallId}
          plans={pendingPlansList}
          isStreaming={isStreaming}
          onApprove={handlePlanApprove}
          onDismiss={handlePlanDismiss}
        />
      )}
      {pendingUserAsks.length > 0 && (
        <UserAskQuestionHighlight
          key={pendingUserAsks.map(p => p.toolCallId).join("|")}
          userAskParts={pendingUserAsks}
          isStreaming={isStreaming}
          onSubmit={handleUserAskSubmit}
        />
      )}
    </div>
  );
}
```

#### Removed

- `bannerNode` ternary / `if/else if` cascade
- `bannerNeedsBg` flag and `cn(..., bannerNeedsBg && "bg-background")` wrapper class
- `TodosHighlight`'s `bannerActive` prop and its `useEffect`
- `HighlightCard` (from `card.tsx`)

#### React keying for "fresh per instance" (decision 6)

| Banner | Key | Effect |
|---|---|---|
| Todos | (no key — single instance per thread) | Collapse state persists across `todo_write` updates |
| User ask | pipe-joined `toolCallId`s | Adding/removing a question changes key → remounts → fresh default |
| Plan | first plan's `toolCallId` | New plan replaces old → remount → fresh default |
| Approval | pipe-joined `approvalId`s | Approval list grows → remount → fresh default |
| Error | (no key) | Same `error` object across re-renders preserves state |
| Warning | (no key) | Same `finishReason` across re-renders preserves state |

## Edge cases

| Case | Behavior |
|---|---|
| No banners and no todos | Wrapper renders empty — invisible, zero footprint |
| Streaming question (`isStreaming === true`) | `UserAskLoadingUI` bypasses the shell; shimmer placeholder |
| Credit-exhausted error | Early-return modal — unchanged |
| User mid-type, agent adds another question | Composite key changes → form remounts → typed text lost. Pre-existing limitation, not new. |
| Banner with `variant="error"` collapsed | Chip row shows the error variant's translucent-red overlay; user sees `⚠ Error occurred ▾` even when collapsed |
| Click chip while body has focus | Toggling closes the body; focus jumps back to chip via browser default |
| 4+ banners stacked, short viewport | Each card respects `max-w-[584px]`; vertical stacking can exceed viewport. Out of scope for v1 — collapse mitigates by allowing users to reduce any stack to chips. |
| `aria-expanded` | Chip button carries `aria-expanded={expanded}` |

## Testing

**Must-have unit tests** — none new (`CollapsibleHighlight` is a presentation component without extracted pure logic; existing `derive-chip-label.test.ts` continues to cover todos chip).

**Manual smoke** (executed against the dev server):

1. Force a question → chip shows `❓ Question pending`, body expanded by default. Click chip to collapse. Click to re-expand. Type in field, click chip to collapse, click to re-expand — typed text preserved.
2. With question still pending, trigger a tool error in a prior turn — both render concurrently. Question card at bottom (closest to input); error card above it. Both individually collapsible.
3. Multi-question case (3 `user_ask` parts) — chip shows `❓ Question pending · 1 of 3`. Navigate pagination — count updates.
4. With question + error visible, navigate to a thread with todos — three banners stacked: todos top, error middle, question bottom.
5. Verify the todos chip default state — first render of a thread with todos = chip closed (not expanded by default).
6. Approve a plan / dismiss an error / answer a question — the resolved banner disappears, others stay.

## Out of scope

- Animations / transitions on collapse-expand
- Drag-to-reorder the stack
- Per-user / per-thread collapse preference persistence
- Slot scroll when stack exceeds viewport
- Replacing the `Tabs` indirection in multi-question

## Verification checklist (for implementation)

- `bun run check` clean across workspaces
- `bun run lint` clean (no new `ban-use-effect` violations — the previous `useEffect` in todos goes away with this change)
- `bun run fmt:check` clean
- `bun test apps/mesh/src/web/components/chat/highlight/derive-chip-label.test.ts` — 6/6 pass
- Smoke per the testing section above

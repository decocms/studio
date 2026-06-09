# Chat Autoscroll Sentinel Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the chat auto-scroll sentinel from inside the streaming assistant message to a fixed position at the bottom of the chat scroll container, so any 1 px upward scroll instantly disengages auto-scroll regardless of message length.

**Architecture:** Restructure `ChatMessages` so `paddingBottom` (highlight-stack reserve) lives on an inner wrapper instead of the scroll container itself, and append a single zero-height bottom sentinel as the literal last child of the scroller. The sentinel uses the existing `useAutoScroll` hook in container mode against the scroll ref. The per-message `<SmartAutoScroll/>` component is deleted along with its sole usage in `assistant.tsx`.

**Tech Stack:** React 19, the existing `useAutoScroll` hook in `@deco/ui`, the existing `useChatStream` selector hook for `isStreaming`.

**Spec:** [`docs/superpowers/specs/2026-06-03-chat-autoscroll-sentinel-placement-design.md`](../specs/2026-06-03-chat-autoscroll-sentinel-placement-design.md)

---

## Testing strategy

Per `TESTING.md`, this repo has two tiers — `bun test` for **pure logic only** (no DOM, no mocks of own code, no React rendering) and Playwright e2e for everything behavioural. This change is a pure DOM rearrangement: no new pure functions, no new SQL, no new HTTP route. There is nothing for the unit tier to cover honestly.

An e2e test would require driving a real streaming chat with a real model provider, then simulating a user scroll mid-stream and asserting `scrollTop` doesn't snap back. No existing chat-streaming UI e2e harness exists in this repo (`chat-input-draft.spec.ts` exercises sessionStorage drafts, not streaming; `decopilot-messages.spec.ts` only gates the HTTP dispatch route). Building that harness — model provider stub, deterministic streaming, viewport-aware scroll assertions — is a large project unto itself, disproportionate to a small layout fix that the engineer can verify in 60 seconds in `bun run dev`.

**Decision:** No automated test. Each task ends with a structured manual-verification step against `bun run dev`. If a regression surfaces later, that justifies investing in the chat-streaming e2e harness as a separate project.

If you (the implementing engineer) disagree, **stop and surface this in code review** before adding tests — don't silently invent the harness mid-task.

---

## File structure

**Modify:**
- `apps/mesh/src/web/components/chat/index.tsx` — `ChatMessages` component. Add bottom sentinel, restructure `paddingBottom` onto an inner wrapper.
- `apps/mesh/src/web/components/chat/message/assistant.tsx` — remove the per-message `<SmartAutoScroll/>` render and its import.

**Delete:**
- `apps/mesh/src/web/components/chat/message/smart-auto-scroll.tsx` — no callers after the change above.

**Unchanged (called out so the engineer doesn't touch them):**
- `packages/ui/src/hooks/use-auto-scroll.ts` — the hook itself, still used by tool-call detail boxes.
- `apps/mesh/src/web/components/chat/message/parts/tool-call-part/common.tsx` — tool-call detail sentinels stay as-is.
- `useTopSentinel` in `apps/mesh/src/web/components/chat/index.tsx` — older-pages fetcher, different observer.

---

## Task 1: Restructure ChatMessages and add the bottom sentinel

**Files:**
- Modify: `apps/mesh/src/web/components/chat/index.tsx` (`ChatMessages` component, around lines 119–183)
- Modify: `apps/mesh/src/web/components/chat/message/assistant.tsx` (delete sentinel render around line 795 and the import around line 32)

### Step 1.1: Read the current `ChatMessages` implementation

- [ ] **Read `apps/mesh/src/web/components/chat/index.tsx`** in full so you have the surrounding context (the file is ~218 lines).

Particularly note:
- Line 119: `function ChatMessages() { ... }`
- Line 136: `const paddingBottom = highlightCount * HIGHLIGHT_COLLAPSED_HEIGHT_PX + 16;`
- Lines 138–146: `scrollRef`, top `sentinelRef`, `useTopSentinel(...)` call.
- Lines 148–182: JSX with `<div ref={scrollRef} ... style={{ paddingBottom }}>` wrapping two inner blocks (older-pairs wrapper at 155–170, last-pair wrapper at 171–180).

### Step 1.2: Add the `useAutoScroll` import

- [ ] **Modify `apps/mesh/src/web/components/chat/index.tsx`** — add the import at the top of the file, alongside the existing UI imports (after the `@deco/ui/lib/utils.ts` import, before the React imports):

```diff
  import { cn } from "@deco/ui/lib/utils.ts";
+ import { useAutoScroll } from "@deco/ui/hooks/use-auto-scroll.ts";
  import {
    useEffect,
    useRef,
    type PropsWithChildren,
    type RefObject,
  } from "react";
```

### Step 1.3: Wire the bottom-sentinel hook inside `ChatMessages`

- [ ] **In `ChatMessages`** (`apps/mesh/src/web/components/chat/index.tsx`, around line 119), after the existing `useTopSentinel(...)` call (line 146), add the bottom-sentinel hook call. The `useChatStream()` destructure on line 120 already needs `isStreaming` — extend it.

Replace the existing destructure (lines 120–126):

```tsx
  const {
    messages,
    status,
    hasMoreOlder,
    isFetchingOlder,
    fetchOlderMessages,
  } = useChatStream();
```

with:

```tsx
  const {
    messages,
    status,
    hasMoreOlder,
    isFetchingOlder,
    fetchOlderMessages,
    isStreaming,
  } = useChatStream();
```

Then, after the `useTopSentinel({ ... });` call (after line 146), add:

```tsx
  // Bottom sentinel: pins the chat scroll to the bottom while the assistant
  // is streaming. Rendered as the literal last child of the scroller so its
  // y-position == scroller.scrollHeight — any upward scroll of 1px instantly
  // disengages tracking (via IntersectionObserver in container mode).
  // See: docs/superpowers/specs/2026-06-03-chat-autoscroll-sentinel-placement-design.md
  const lastAssistantParts = lastMessagePair?.assistant?.parts;
  const { sentinelRef: bottomSentinelRef } = useAutoScroll({
    containerRef: scrollRef,
    enabled: isStreaming,
    contentDeps: [lastAssistantParts?.length, lastAssistantParts?.at(-1)],
  });
```

Note: `lastMessagePair` is already defined on line 128 (`const lastMessagePair = messagePairs.at(-1);`), so it's in scope.

### Step 1.4: Restructure the scroller JSX

- [ ] **In `ChatMessages`** (`apps/mesh/src/web/components/chat/index.tsx`), replace the return block (lines 148–182). The two changes here are:

1. Move `style={{ paddingBottom }}` from the outer `<div ref={scrollRef} ...>` onto a new inner `<div>` that wraps both existing children.
2. Append the bottom sentinel `<div>` as the last child of the scroller, *outside* the new `paddingBottom` wrapper.

Replace:

```tsx
  return (
    <div
      ref={scrollRef}
      data-chat-scroller
      className="w-full min-w-0 max-w-full overflow-y-auto h-full overflow-x-hidden"
      style={{ paddingBottom }}
    >
      <div className="flex flex-col min-w-0 max-w-2xl mx-auto w-full">
        <div ref={sentinelRef} aria-hidden className="h-px" />
        {isFetchingOlder && (
          <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
            Loading older messages…
          </div>
        )}
        {messagePairs.slice(0, -1).map((pair, index) => (
          <MessagePair
            key={`pair-${pair.user?.id ?? pair.assistant?.id}`}
            pair={pair}
            isLastPair={false}
            status={index === messagePairs.length - 1 ? status : undefined}
          />
        ))}
      </div>
      {lastMessagePair && (
        <div className="min-h-full min-w-0 max-w-2xl mx-auto w-full">
          <MessagePair
            key={`pair-${lastMessagePair.user?.id ?? lastMessagePair.assistant?.id}`}
            pair={lastMessagePair}
            isLastPair={true}
            status={status}
          />
        </div>
      )}
    </div>
  );
```

with:

```tsx
  return (
    <div
      ref={scrollRef}
      data-chat-scroller
      className="w-full min-w-0 max-w-full overflow-y-auto h-full overflow-x-hidden"
    >
      <div style={{ paddingBottom }}>
        <div className="flex flex-col min-w-0 max-w-2xl mx-auto w-full">
          <div ref={sentinelRef} aria-hidden className="h-px" />
          {isFetchingOlder && (
            <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
              Loading older messages…
            </div>
          )}
          {messagePairs.slice(0, -1).map((pair, index) => (
            <MessagePair
              key={`pair-${pair.user?.id ?? pair.assistant?.id}`}
              pair={pair}
              isLastPair={false}
              status={index === messagePairs.length - 1 ? status : undefined}
            />
          ))}
        </div>
        {lastMessagePair && (
          <div className="min-h-full min-w-0 max-w-2xl mx-auto w-full">
            <MessagePair
              key={`pair-${lastMessagePair.user?.id ?? lastMessagePair.assistant?.id}`}
              pair={lastMessagePair}
              isLastPair={true}
              status={status}
            />
          </div>
        )}
      </div>
      <div ref={bottomSentinelRef} aria-hidden className="h-0" />
    </div>
  );
```

**What changed:**
- Outer `<div ref={scrollRef} ...>` no longer has `style={{ paddingBottom }}`.
- A new `<div style={{ paddingBottom }}>` now wraps both the older-pairs flex container and the last-pair `min-h-full` container.
- The bottom sentinel `<div ref={bottomSentinelRef} aria-hidden className="h-0" />` is appended as the final child of the scroll container (outside the padding wrapper).

### Step 1.5: Remove the per-message sentinel render

- [ ] **Modify `apps/mesh/src/web/components/chat/message/assistant.tsx`** — delete the import (around line 32) and the render (around line 795).

Delete the import line:

```diff
- import { SmartAutoScroll } from "./smart-auto-scroll.tsx";
```

Delete the render block (lines 794–795):

```diff
-       {/* Smart auto-scroll sentinel - only rendered for the last message during streaming */}
-       {isLast && isStreaming && <SmartAutoScroll parts={message?.parts} />}
        </Container>
```

### Step 1.6: Format, type-check, lint

- [ ] **Run** `bun run fmt`
  - Expected: no diff, or only trivial whitespace fixes in the two files just touched.
- [ ] **Run** `bun run check`
  - Expected: pass. (If TypeScript complains that `isStreaming` is not on the destructure type, double-check Step 1.3 — the `ChatContextValue` already exposes `isStreaming: boolean` per `apps/mesh/src/web/components/chat/chat-context.tsx:122`.)
- [ ] **Run** `bun run lint`
  - Expected: pass. (No new `useEffect`/`useMemo`/`useCallback`/`memo` introduced; no `console.log`; no hand-rolled sleep/retry.)

### Step 1.7: Manual verification in dev

- [ ] **Start dev:** `bun run dev` (or, if already running, confirm the Vite HMR picked up the change).
- [ ] **Sign in and open a chat thread** with at least one prior assistant message visible.
- [ ] **Verification A — sentinel position before streaming:**
  - Open devtools, find `[data-chat-scroller]`.
  - The first direct child should be the new `<div style="padding-bottom: ...">` wrapper.
  - The second (and last) direct child should be `<div aria-hidden class="h-0">` — the bottom sentinel.
  - The wrapper's computed `padding-bottom` should equal `highlightCount * HIGHLIGHT_COLLAPSED_HEIGHT_PX + 16` (typically `16px` when no highlights are open).
  - The scroller itself should no longer have `padding-bottom` (only the wrapper does).
- [ ] **Verification B — short streaming message stays pinned at start:**
  - Send a message that triggers a long-ish response (e.g. "list 10 reasons foo").
  - As the first tokens arrive, the chat should auto-pin to the bottom (sentinel visible at the bottom edge of the scroller).
- [ ] **Verification C — the bug is gone (the main fix):**
  - Send a message that triggers a long-ish response.
  - **As soon as the first character appears** (before the message body fills the viewport), scroll up by a small amount (a single mouse-wheel tick or trackpad nudge).
  - The chat should **stop snapping back to the bottom** within ~500 ms.
  - Streaming continues as text accumulates; you stay where you scrolled to. This is the behaviour the fix exists to deliver.
- [ ] **Verification D — re-engaging tracking works:**
  - With the same thread, scroll all the way back to the bottom.
  - Auto-scroll should resume — new streamed tokens should keep the view pinned to the bottom.
- [ ] **Verification E — long streaming message still pins:**
  - Send a message that triggers a several-screen-long response.
  - Without touching the scroll, the chat should keep pinning to the bottom as text accumulates.
- [ ] **Verification F — highlights still reserve their space:**
  - Trigger a flow that opens a highlight (e.g. an approval prompt that renders into the highlight stack at the bottom).
  - The last assistant message should still sit above the highlight stack — the `paddingBottom` reserve still applies (it just lives on the inner wrapper now).
- [ ] **Verification G — tool-call detail box auto-scroll still works:**
  - Trigger a tool call that produces streaming detail logs and expand the collapsible.
  - The detail box's bottom should auto-pin while the tool runs (this is the *other* `useAutoScroll` usage, untouched by this change).

If any verification fails, **stop and investigate** before committing.

### Step 1.8: Commit

- [ ] **Run**:
  ```bash
  git add apps/mesh/src/web/components/chat/index.tsx apps/mesh/src/web/components/chat/message/assistant.tsx
  git commit -m "fix(chat): pin auto-scroll sentinel to bottom of scroller

Move the streaming auto-scroll sentinel from inside the last assistant
message to a fixed position at the bottom of the chat scroller, and
relocate paddingBottom onto an inner wrapper so the sentinel sits at
true scrollHeight. Previously, the sentinel rode with the message body
and sat high in the viewport during early streaming — the user had to
scroll up by a viewport-height before the IntersectionObserver
disengaged auto-scroll, and the 500ms interval kept yanking them back.
Now any 1px upward scroll disengages tracking instantly."
  ```

---

## Task 2: Delete the now-unused `SmartAutoScroll` component

**Files:**
- Delete: `apps/mesh/src/web/components/chat/message/smart-auto-scroll.tsx`

### Step 2.1: Confirm there are no remaining references

- [ ] **Run** `grep -rn "SmartAutoScroll\|smart-auto-scroll" apps packages` (excluding the file itself).
- Expected: zero matches — the only reference was the import + render in `assistant.tsx`, both removed in Task 1.
- If any match exists, **stop and investigate** (probably a missed call site).

### Step 2.2: Delete the file

- [ ] **Run** `git rm apps/mesh/src/web/components/chat/message/smart-auto-scroll.tsx`

### Step 2.3: Re-run typecheck, lint, format

- [ ] **Run** `bun run check`
  - Expected: pass. (Confirms no other module imports from the deleted file.)
- [ ] **Run** `bun run lint`
  - Expected: pass.
- [ ] **Run** `bun run fmt:check`
  - Expected: pass. (No code changed beyond the deletion, so nothing to format.)

### Step 2.4: Commit

- [ ] **Run**:
  ```bash
  git commit -m "chore(chat): delete unused SmartAutoScroll component

After fix(chat): pin auto-scroll sentinel to bottom of scroller, this
per-message sentinel has no callers. The shared useAutoScroll hook in
@deco/ui stays — it's still used by the tool-call detail box."
  ```

---

## Task 3: Final repo-wide checks

### Step 3.1: Run the full test suite

- [ ] **Run** `bun test`
- Expected: pass. (No tests touch chat scroll behaviour, so this is just confirming no incidental breakage in other tests that happen to import from the changed files.)

### Step 3.2: Final lint and typecheck

- [ ] **Run** `bun run check`
- [ ] **Run** `bun run lint`
- [ ] **Run** `bun run fmt:check`
- Expected: all pass.

### Step 3.3: Sanity-scan the diff

- [ ] **Run** `git log --oneline -5`
- Expected: two new commits — `fix(chat): pin auto-scroll sentinel...` and `chore(chat): delete unused SmartAutoScroll...`.
- [ ] **Run** `git diff HEAD~2 HEAD --stat`
- Expected: three files touched — `index.tsx` (modified), `assistant.tsx` (modified), `smart-auto-scroll.tsx` (deleted).

If anything looks unexpected, **stop and investigate**.

---

## Self-review notes (from the plan author)

- **Spec coverage:** Every numbered change in the spec (the `index.tsx` diff, the `assistant.tsx` diff, the `smart-auto-scroll.tsx` deletion, the `isStreaming` gate, the `contentDeps` shape, the `paddingBottom` relocation) is addressed by Task 1 or Task 2. The "what is unchanged" section of the spec is mirrored in the file-structure section above so the engineer knows what *not* to touch.
- **Placeholders:** All code is shown literally — no "similar to above", no "add error handling", no "TBD". Every command has expected output.
- **Type consistency:** `bottomSentinelRef` is named consistently in Step 1.3 (where it's destructured from `useAutoScroll`) and Step 1.4 (where it's attached to the new `<div>`). `lastAssistantParts` is used only within Step 1.3 and not referenced later. `isStreaming` matches the boolean field on `ChatContextValue` per `chat-context.tsx:122`.
- **No new automated tests:** Justified up-front under "Testing strategy" with explicit instruction to surface in code review if the implementing engineer disagrees, rather than silently inventing a harness mid-task.

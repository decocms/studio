# Chat Autoscroll Sentinel Placement

## Problem

Auto-scroll during chat streaming "fights" the user. When a new assistant
message starts streaming, its body is initially empty or just a few characters.
The `<SmartAutoScroll/>` sentinel that gates auto-scroll lives *inside* that
assistant message — so its y-position is near the **top** of the scroll
viewport, not near the bottom.

The `useAutoScroll` hook uses an `IntersectionObserver` to flip `isTracking`:
when the sentinel is visible, it scrolls to bottom on a 500 ms interval and on
every content change; when the sentinel leaves view, it stops. The intent is
"if the user scrolls away, stop yanking them back".

But when the sentinel is high in the viewport, the user has to scroll up by
~`(viewportHeight − sentinelY)` pixels before the sentinel falls out the top
edge of the observer root. Until that happens, every 500 ms tick scrolls them
back to the bottom. The visible symptom: you "have to scroll rapidly" upward
to escape, and any gentle drag is ignored.

## Goal

The bottom sentinel should sit at the **actual bottom edge of the scroll
container** at all times — directly above the chat input visually — so that
any upward scroll of even one pixel immediately removes it from the observer
root and disables auto-scroll. No matter how short or long the streaming
message is, the trip-wire is in the same place.

## Current layout (the bug)

```
┌─ <div data-chat-scroller> (the scroll viewport / observer root) ─┐
│                                                                   │
│  ┌─ MessagePair (older) ─────────────────────┐                    │
│  │ user: "explain the autoscroll"            │                    │
│  │ assistant: (long answer with 30 parts)    │                    │
│  └───────────────────────────────────────────┘                    │
│                                                                   │
│  ┌─ MessagePair (last, isStreaming=true) ────┐                    │
│  │ user: "now fix it"                        │                    │
│  │ assistant:                                │                    │
│  │   TypingIndicator / first 3 chars         │                    │
│  │   ◆ <SmartAutoScroll/>  ← sentinel HERE   │  ◀── visible HERE  │
│  └───────────────────────────────────────────┘                    │
│                                                                   │
│   ░░░░ (rest of viewport — empty / min-h-full) ░░░░               │
│   ░░░░                                                            │
│   ░░░░ paddingBottom (highlights + 16px reserve) ░░░░             │
└───────────────────────────────────────────────────────────────────┘
┌─ ChatFooter ──────────────────────────────────────────────────────┐
│  [ ChatInput ]                                                    │
└───────────────────────────────────────────────────────────────────┘
```

The sentinel rides with the message body. The further from the bottom edge it
sits, the larger the upward-scroll distance required to disengage tracking.

## Target layout

```
┌─ <div data-chat-scroller> (NO paddingBottom anymore) ────────────┐
│                                                                   │
│  ┌─ contentWrapper { paddingBottom: highlights + 16 } ────────┐   │
│  │                                                            │   │
│  │  ┌─ MessagePair (older) ─────────────────┐                 │   │
│  │  │ ...                                   │                 │   │
│  │  └───────────────────────────────────────┘                 │   │
│  │                                                            │   │
│  │  ┌─ MessagePair (last, streaming) ───────┐                 │   │
│  │  │ assistant: (3 chars so far)           │                 │   │
│  │  └───────────────────────────────────────┘                 │   │
│  │                                                            │   │
│  │   ░░ paddingBottom reserve (so highlights don't cover) ░░  │   │
│  └────────────────────────────────────────────────────────────┘   │
│  ◆ <BottomSentinel/>   ← y == scrollHeight, exact bottom edge   ◀─┤
└───────────────────────────────────────────────────────────────────┘
┌─ ChatFooter ──────────────────────────────────────────────────────┐
│  [ ChatInput ]                                                    │
└───────────────────────────────────────────────────────────────────┘
```

The single bottom sentinel is the **last child of the scroll container**, and
the `paddingBottom` (highlight-stack reserve) is moved one level inward onto a
new `contentWrapper`. With paddingBottom no longer growing the scroll container
itself, the sentinel sits at `y == scrollHeight` — i.e. exactly at the bottom
edge of the observer root when `scrollTop === max`.

## Trip-wire invariant

```
sentinel.y === scroller.scrollHeight
       ↓
visible at scrollTop = max (touches bottom edge of observer root)
       ↓
ANY upward scroll → sentinel.y > visibleBottom → not intersecting
       ↓
isTracking = false → interval no-ops, content-effect no-ops
       ↓
user is free, no fight
```

## Changes

### 1. `apps/mesh/src/web/components/chat/index.tsx` — `ChatMessages`

Restructure the scroller and add the bottom sentinel:

```diff
+ import { useAutoScroll } from "@deco/ui/hooks/use-auto-scroll.ts";
  ...
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
+ const { isStreaming } = useChatStream();
+ const lastPartsLen = lastMessagePair?.assistant?.parts?.length;
+ const lastPart = lastMessagePair?.assistant?.parts?.at(-1);
+ const { sentinelRef: bottomSentinelRef } = useAutoScroll({
+   containerRef: scrollRef,
+   enabled: isStreaming,
+   contentDeps: [lastPartsLen, lastPart],
+ });
  ...
  return (
    <div
      ref={scrollRef}
      data-chat-scroller
      className="w-full min-w-0 max-w-full overflow-y-auto h-full overflow-x-hidden"
-     style={{ paddingBottom }}
    >
+     <div style={{ paddingBottom }}>
        <div className="flex flex-col min-w-0 max-w-2xl mx-auto w-full">
          <div ref={sentinelRef} aria-hidden className="h-px" />
          {isFetchingOlder && (...)}
          {messagePairs.slice(0, -1).map(...)}
        </div>
        {lastMessagePair && (
          <div className="min-h-full min-w-0 max-w-2xl mx-auto w-full">
            <MessagePair .../>
          </div>
        )}
+     </div>
+     <div ref={bottomSentinelRef} aria-hidden className="h-0" />
    </div>
  );
```

The `useChatStream()` hook already exposes `isStreaming` (used by
`apps/mesh/src/web/components/chat/input.tsx:242`), so no new plumbing is
needed.

### 2. `apps/mesh/src/web/components/chat/message/assistant.tsx`

Delete the per-message sentinel render and its import:

```diff
- import { SmartAutoScroll } from "./smart-auto-scroll.tsx";
  ...
-   {/* Smart auto-scroll sentinel - only rendered for the last message during streaming */}
-   {isLast && isStreaming && <SmartAutoScroll parts={message?.parts} />}
  </Container>
```

### 3. Delete `apps/mesh/src/web/components/chat/message/smart-auto-scroll.tsx`

After step 2 it has no callers. The underlying hook `useAutoScroll` in
`packages/ui/src/hooks/use-auto-scroll.ts` stays — it is still used by
`apps/mesh/src/web/components/chat/message/parts/tool-call-part/common.tsx`
for tool-call detail boxes (a different scroll container with its own
lifecycle).

## Why this is correct

The current sentinel approximates "is the bottom of the last message visible?".
That coincides with "is the chat scrolled to the bottom?" only when the message
itself reaches the bottom edge — which it doesn't during early streaming.

The new sentinel directly answers "is the scroller at `scrollTop === max`?",
because the sentinel is the literal last DOM node inside the scroller and has
zero height. There is no message-content dependency between the sentinel's
position and the scroll bottom.

Moving `paddingBottom` from the scroller to an inner wrapper is what makes the
trip-wire 1 px wide instead of `paddingBottom` px wide. If the padding stayed
on the scroller, the sentinel (as the last child) would sit `paddingBottom`
pixels above the actual bottom edge, and the user would have to scroll up by
~`paddingBottom` pixels to disengage tracking. Better than today, but not
"instant".

## What is unchanged

- **Tool-call detail sentinels** in
  `apps/mesh/src/web/components/chat/message/parts/tool-call-part/common.tsx`.
  These pin the bottom of a `max-h-[150px] overflow-y-auto` log box during
  tool execution; they use `useAutoScroll` in container mode against their own
  scroll container and are unrelated to the chat-thread sentinel.
- **The top sentinel (older-pages fetcher)** in `useTopSentinel`. Different
  observer, different purpose.
- **The `useAutoScroll` hook itself.** No API changes.
- **`min-h-full` on the last-pair wrapper.** Still required to let a single
  message fill the viewport. The new `contentWrapper` is not `min-h-full`; only
  its last-pair child is, exactly as before.

## Behavioural details

- **Streaming gate.** The new bottom sentinel is gated on `isStreaming` from
  `useChatStream()`, matching the existing `isLast && isStreaming` gating on
  the deleted `<SmartAutoScroll/>`. When `isStreaming` is false the hook still
  attaches the observer (cheap) but `enabled` is false so neither the 500 ms
  interval nor the content-change effect does any scrolling.
- **Content dependencies.** `[lastPartsLen, lastPart]` — same shape the
  deleted component used (`partsLength`, `lastPart`). Each new or mutated part
  on the streaming assistant message triggers an immediate `scrollToBottom()`
  if `isTracking` is true.
- **Re-engaging tracking.** If the user scrolls up and back down, the sentinel
  re-enters the observer root and `isTracking` flips back to true. With the
  new placement "all the way back down" means literally `scrollTop === max`,
  which is a clearer mental model than "the bottom of the last message has
  re-entered the viewport".
- **Scrolling target.** Container mode (`containerRef: scrollRef`) — the hook
  sets `scrollRef.current.scrollTop = scrollRef.current.scrollHeight`, which
  is identical to the existing viewport-mode behaviour because the walked-up
  scrollable parent today *is* `scrollRef`.

## Risks and mitigations

- **Layout regressions from moving `paddingBottom`.** The padding now lives on
  an inner wrapper instead of the scroller, but the rendered box model is the
  same: same children, same width constraints (the existing `max-w-2xl mx-auto`
  wrappers stay where they are, one level deeper inside the new wrapper). The
  highlight stack still overlays the bottom of the viewport and the padding
  still reserves space so the last message isn't covered.
- **Sentinel re-attach timing.** The hook already uses a `setState` callback
  ref so the observer re-binds when the sentinel node mounts. The bottom
  sentinel is unconditionally rendered (it's not inside a `Collapsible`), so
  there is no late-mount edge case.
- **`min-h-full` interaction.** The last-pair child uses `min-h-full` to fill
  the viewport. After the move, "full" is computed against the new wrapper's
  height rather than the scroller's, but the wrapper's height equals
  `scroller.clientHeight - paddingBottom` only if its content is short; for
  short content the wrapper expands to fit the `min-h-full` child anyway,
  which is the desired behaviour. No regression expected.

## Out of scope

- Changes to `useAutoScroll`'s API or defaults.
- Reworking how `paddingBottom` is computed from `highlightCount`.
- Tool-call detail-box auto-scroll.
- The older-pages top sentinel (`useTopSentinel`).

# Centered Chat Input for Thread Routes — Design

**Status:** Draft
**Date:** 2026-06-03
**Owner:** tlgimenes@gmail.com
**Scope:** `/$org/$taskId` routes only

## Problem

Today the thread view (`/$org/$taskId`) renders an empty thread as a large
centered agent icon + title + description + icebreaker chips, with the chat
input docked at the bottom of the panel. The Branch selector lives in the
agent-shell header next to "Save changes / Open PR"; the Harness selector
and Model selector live in the bottom row of the chat input.

This layout has three problems:

1. **Visual weight is misplaced.** The agent identity block dominates the
   empty state, but what the user actually needs is the input itself.
2. **Thread-setup controls are scattered.** Branch lives in the header;
   Harness lives in the input. The user has to look in two places to
   "configure this thread" before sending.
3. **Inconsistent with industry-standard chat UX** (Cursor 3.0, ChatGPT,
   Claude.ai), which all center a single composer in the empty state and
   dock it at the bottom once a conversation has started.

## Goals

1. Replace the centered-agent-block + bottom-docked-input layout with a
   single vertically centered composer in the empty state.
2. Above the centered composer, surface the "lock-on-first-send"
   controls — Branch + Harness — so the user can configure both without
   looking up at the header.
3. Move the Branch selector out of the agent-shell header entirely; it
   lives only in the composer.
4. On first send, dock the composer to the bottom and fold Branch +
   Harness into the input's bottom row as disabled pills (matching the
   existing `messages.length > 0` lock semantics).
5. Keep Model as a per-turn control in the bottom row of the input
   across all states — it never locks, it never appears above.
6. Preserve icebreakers as the discovery affordance, rendered below the
   centered composer in the empty state.

## Non-goals

- **Home composer (`/$org/`) is unchanged.** The new layout applies
  strictly to `/$org/$taskId`.
- **No animated slide / FLIP transition.** A simple crossfade between
  the empty and submitted layouts is sufficient.
- **No new pill style.** Selectors reuse the existing pill components.
- **No mobile-specific tuning.** Mobile inherits the desktop layout; a
  separate mobile pass is a follow-up.
- **The central agent icon + title + description block is deleted.** It
  is not replaced by a smaller version.

## Decisions

| # | Decision |
|---|---|
| 1 | BranchPill is removed from `HeaderActions`; it lives only in the composer. |
| 2 | Scope is strictly `/$org/$taskId`. Home composer (`HomePage`) is unchanged. |
| 3 | Icebreakers render below the centered input in the empty state. |
| 4 | Center → bottom transition is a crossfade (Tailwind `animate-in fade-in-0`). |
| 5 | Selector pills reuse existing `BranchPill` and `ModePicker` components. |
| 6 | Above-row renders only the pills whose capability gate passes. Non-clonable agent with no repo → no above-row. |
| 7 | Above-row holds Branch + Harness only. Model stays in the bottom row of the input in every state. |
| 8 | Above-row visibility tracks `messages.length === 0` (matches existing `isChatEmpty`). Typing mid-compose does not hide it. |

## Visual states

### State A — Empty thread (proposed)

```
┌──────────────────────── /$org/$taskId ───────────────────────────┐
│ Header: [Save changes / Open PR]                                 │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│            [⌥ Branch ▾]  [☁ Harness ▾]    ← above-row            │
│          ┌────────────────────────────────────────┐              │
│          │  What do you want to build?            │              │
│          │                                        │              │
│          │  [+][Tools]    [⚡ Model ▾]   [🎙][⬆]  │              │
│          └────────────────────────────────────────┘              │
│                                                                  │
│       [icebreaker 1]  [icebreaker 2]  [icebreaker 3]             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### State B — After first send (docked)

```
┌──────────────────────── /$org/$taskId ───────────────────────────┐
│ Header: [Save changes / Open PR]                                 │
├──────────────────────────────────────────────────────────────────┤
│ [user message]                                                   │
│ [assistant message...]                                           │
│ [tool calls, etc.]                                               │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │  Type next message…                                          │ │
│ │                                                              │ │
│ │  [+][Tools]  [⌥main🔒][☁Cloud🔒][⚡Model ▾]   [🎙][⬆]        │ │
│ └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### State C — Non-clonable agent (empty)

```
┌──────────────────────── /$org/$taskId ───────────────────────────┐
│ Header: [Save changes / Open PR]                                 │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│          ┌────────────────────────────────────────┐              │
│          │  What do you want to build?            │              │
│          │                                        │              │
│          │  [+][Tools]    [⚡ Model ▾]   [🎙][⬆]  │              │
│          └────────────────────────────────────────┘              │
│                                                                  │
│       [icebreaker 1]  [icebreaker 2]  [icebreaker 3]             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

(No above-row because neither Branch nor Harness applies.)

## Architecture

### Approach: Two layouts, one input

`ChatPanelContent` (in `side-panel-chat.tsx`) owns the layout choice:

- **`isChatEmpty === true`** → mount a new `CenteredComposer`
  containing the above-row, `Chat.Input`, and `Chat.IceBreakers`,
  vertically centered.
- **`isChatEmpty === false`** → mount the existing layout:
  `Chat.Main → Chat.Messages` + `Chat.Footer → Chat.Input`.

`Chat.Input` reads `isChatEmpty` from `useChatStream()` and
conditionally omits `<ChatModeRow>` from its bottom row when empty
(the row is rendered above by `CenteredComposer`). Otherwise the
input is unchanged.

`ChatModeRow` is extended to compose `BranchPill` next to
`ModePicker`. Each pill renders independently based on its own
capability gate (`getActiveGithubRepo` for BranchPill,
`agentHasClonableSource` for ModePicker). The component returns
`null` when neither gate passes.

`HeaderActions` (`thread/github/header-actions.tsx`) drops the
`<BranchPill>` and the leading `<Separator>` entirely; the header
shows only the action button (`Save changes` / `Open PR` / etc.).

```
ChatPanelContent
├── if isChatEmpty:
│      Chat.Main (centered, fades in)
│        └─ CenteredComposer
│             ├── ChatModeRow         (above-row, unlocked)
│             │     ├── BranchPill    (gated: has GitHub repo)
│             │     └── ModePicker    (gated: clonable agent)
│             ├── Chat.Input          (skips ChatModeRow in bottom row)
│             └── Chat.IceBreakers
│
└── else:
       Chat.Main (fades in)
         └─ Chat.Messages
       Chat.Footer
         └─ Chat.Input
              └── bottom row: …ChatModeRow (Branch + Harness, locked) …
```

### File inventory

**Modified:**

| File | Change |
|---|---|
| `apps/mesh/src/web/components/chat/side-panel-chat.tsx` | Replace `SidebarEmptyState` with `CenteredComposer`. Layout swap inside `ChatPanelContent`. Delete `SidebarEmptyState` function. |
| `apps/mesh/src/web/components/chat/input.tsx` | Wrap the `<ChatModeRow>` render site (~line 619–624) in `{!isChatEmpty && (...)}`. No other changes. |
| `apps/mesh/src/web/components/chat/pills/chat-mode-row.tsx` | Extend to compose `BranchPill` + `ModePicker`. Update `PureProps` for tests. |
| `apps/mesh/src/web/components/thread/github/header-actions.tsx` | Remove `<BranchPill>` block and preceding `<Separator>`. |

**New:**

| File | Purpose |
|---|---|
| `apps/mesh/src/web/components/chat/centered-composer.tsx` | New leaf component (~60 lines). Composes above-row + `Chat.Input` + icebreakers, vertically centered. |

**Tests:**

| File | Change |
|---|---|
| `apps/mesh/src/web/components/chat/pills/chat-mode-row.test.tsx` | Extend pure-component test for BranchPill cases. |
| `apps/mesh/src/web/components/chat/centered-composer.test.tsx` (new) | Pure-component test for layout and icebreaker presence. |
| `apps/mesh/e2e/tests/centered-input.spec.ts` (new) | E2E for empty → submitted transition, lock state, non-clonable variant. |

## Component contracts

### `CenteredComposer` (new)

```ts
// apps/mesh/src/web/components/chat/centered-composer.tsx

/**
 * Empty-state composer for /$org/$taskId. Renders:
 *   above-row (Branch + Harness pills, unlocked, gated by capability)
 *   centered Chat.Input
 *   icebreakers (below the input)
 *
 * Mounted by ChatPanelContent when isChatEmpty is true.
 * Reads: useChatPrefs, useVirtualMCP, useChatTask.
 * Owns: no local state.
 */
export function CenteredComposer({
  onOpenContextPanel,
}: {
  onOpenContextPanel: () => void;
}): ReactNode;
```

Layout:

```tsx
<div className="h-full w-full flex flex-col items-center justify-center px-4 gap-6">
  <div className="w-full max-w-3xl flex flex-col gap-3">
    <div className="flex justify-center gap-2">
      <ChatModeRow virtualMcp={fullVm} currentBranch={currentBranch} />
    </div>
    <Chat.Input onOpenContextPanel={onOpenContextPanel} />
    <div className="w-full"><Chat.IceBreakers /></div>
  </div>
</div>
```

Read-only thread fallback: if `taskCtx.activeTask.created_by !== userId`,
render only `<Chat.Input />` (which shows its own "Read only" banner).
Skip the above-row and icebreakers.

### `ChatModeRow` (extended)

```ts
// apps/mesh/src/web/components/chat/pills/chat-mode-row.tsx

interface SmartProps {
  virtualMcp: VirtualMCPEntity | null | undefined;
  currentBranch: string | null;
}

/**
 * Composes BranchPill + ModePicker. Each renders independently:
 *   BranchPill:  getActiveGithubRepo(virtualMcp) is non-null
 *   ModePicker:  agentHasClonableSource(virtualMcp?.metadata)
 * Returns null if both gates fail.
 *
 * Locked flag is derived once here from useOptionalChatStream().messages.length > 0
 * and passed to both children.
 */
export function ChatModeRow({ virtualMcp, currentBranch }: SmartProps): ReactNode;

interface PureProps {
  branchPill: ReactNode;   // BranchPill or null
  modePicker: ReactNode;   // ModePicker or null
}
export function ChatModeRowPure({ branchPill, modePicker }: PureProps): ReactNode;
```

The `placement="chat" | "header"` distinction on `BranchPill` becomes
vestigial (no `"header"` call site remains). The prop is kept in this
PR with default `"chat"`; removal is tracked as a follow-up cleanup.

### `Chat.Input` (single conditional)

```diff
  <div className="flex items-center gap-1.5 min-w-0">
-   <ChatModeRow
-     virtualMcp={fullVm}
-     currentBranch={taskCtx?.currentBranch ?? null}
-   />
+   {!isChatEmpty && (
+     <ChatModeRow
+       virtualMcp={fullVm}
+       currentBranch={taskCtx?.currentBranch ?? null}
+     />
+   )}
    <TierTrigger />
    …
  </div>
```

`isChatEmpty` is already read via `useChatStream()` in this file. No
new prop is required — the input self-corrects wherever it's mounted.

### `ChatPanelContent` (layout swap)

```diff
- <Chat.Main>
-   {!isChatEmpty ? <Chat.Messages /> : <SidebarEmptyState />}
- </Chat.Main>
- <Chat.Footer>
-   <Chat.Input onOpenContextPanel={() => setActivePanel("context")} />
- </Chat.Footer>
+ {isChatEmpty ? (
+   <Chat.Main className="flex flex-col items-center justify-center animate-in fade-in-0 duration-200">
+     <CenteredComposer onOpenContextPanel={() => setActivePanel("context")} />
+   </Chat.Main>
+ ) : (
+   <>
+     <Chat.Main className="animate-in fade-in-0 duration-200">
+       <Chat.Messages />
+     </Chat.Main>
+     <Chat.Footer>
+       <Chat.Input onOpenContextPanel={() => setActivePanel("context")} />
+     </Chat.Footer>
+   </>
+ )}
```

The `SidebarEmptyState` function in `side-panel-chat.tsx` is deleted.
The `showProviderEmptyState` and `showCreditsModal` branches above
this code path are unchanged.

### `HeaderActions` (Branch removal)

```diff
- <Separator orientation="vertical" className="mx-2 ..." />
- <div className="flex items-center gap-2">
-   <BranchPill ... placement="header" />
-   <HeaderButtonRenderer ... />
- </div>
+ <HeaderButtonRenderer ... />
```

The PR/checks data reads (`prQuery`, `gitStatusQuery`, `checksQuery`,
`reviewsQuery`, `parseBranchMap`, `getActiveGithubRepo`,
`useChatTask`) remain — they feed the action button, not the
BranchPill.

## Data flow

```
useChatStream()  ──→ messages, isChatEmpty  ──→ ChatPanelContent (layout choice)
                                                   ↘
                                                    Chat.Input (omit ChatModeRow if empty)
                                                    ChatModeRow (locked flag)

useChatPrefs()   ──→ selectedVirtualMcp     ──→ CenteredComposer ──→ ChatModeRow
useVirtualMCP()  ──→ fullVm + metadata
useChatTask()    ──→ currentBranch, task   ──→ CenteredComposer
                                            ──→ BranchPill onChange (setCurrentTaskBranch)
```

No new context, no new global state. The locked flag
(`messages.length > 0`) is derived in `ChatModeRow` only and applied
to both children — single source of truth.

## Edge cases

| Case | Behavior |
|---|---|
| Read-only thread (`task.created_by !== userId`) | `CenteredComposer` skips above-row and icebreakers, renders `Chat.Input` alone (which shows the existing "Read only" banner). |
| First send (`isChatEmpty` flips false) | `CenteredComposer` unmounts, messages layout mounts. Tiptap draft already cleared by existing submit logic. Crossfade is the visible transition. |
| Switching tasks via sidebar | `ChatMainPanelGroup` keys the panel on `${virtualMcpId}-${taskId}`; the whole tree remounts, layout choice is re-evaluated against the new task. |
| Voice recording in centered state | Voice branch (`Chat.Input` line ~485) takes over the bottom row visually. Above-row remains visible above; no interference. |
| Plan / image / web-search pills | Live on the **left** of the bottom row, not the right where `ChatModeRow` sits. Unaffected by the empty-state gate. |
| Provider empty state, credits modal | Short-circuit higher in `ChatPanelContent`; never reach `CenteredComposer`. Unchanged. |
| Non-clonable agent | `ChatModeRow` returns `null`. Above-row slot collapses (zero-height). Visually: centered input + icebreakers only. |
| Branch loading state | `BranchPicker` already renders a disabled pill while loading. No change needed. |

## Test plan

Per `TESTING.md`: pure logic → unit (`bun test`), everything else → e2e
(Playwright). No mocks of `MeshContext`, DB, or fetch in unit tests.

### Unit

1. **`chat-mode-row.test.tsx`** (extended):
   - non-clonable + no repo → `null`
   - clonable + no repo → only `ModePicker`
   - non-clonable + has repo → only `BranchPill`
   - clonable + has repo → both, BranchPill on left, ModePicker on right
   - `locked=true` → both children receive disabled/locked state
2. **`centered-composer.test.tsx`** (new):
   - Renders `ChatModeRow` + `Chat.Input` + `Chat.IceBreakers` in
     vertical order
   - Applies centering classes (`items-center justify-center`)
   - Read-only thread: omits above-row and icebreakers, shows only
     input

### E2E

3. **`centered-input.spec.ts`** (new, lives in `apps/mesh/e2e/tests/`):
   - Fresh `/$org/$taskId` for a clonable agent → above-row visible
     with Branch + Harness pills, input centered, icebreakers below.
   - Type a message → above-row still visible (Q8: stays during
     compose).
   - Submit → input docks at bottom, above-row gone, Branch + Harness
     rendered inside the bottom row as disabled, Model still
     editable.
   - Disabled Branch pill: click does not open the popover. Model
     pill: click opens the popover.
   - Non-clonable thread → no above-row, centered input only,
     icebreakers below.

Existing e2e infra (Better Auth + real Postgres + known clonable
agent fixture) covers all required setup.

## Rollout

- Single PR. No feature flag — the change is purely presentational
  and reversible by revert.
- `bun run fmt` + `bun run lint` + `bun test` + the new e2e spec
  before requesting review.
- Screenshot of the three visual states (empty clonable, empty
  non-clonable, submitted) in the PR description.

## Follow-ups (not in scope)

- Remove `BranchPill`'s vestigial `placement` prop after this PR
  lands.
- Consider whether the home composer (`HomePage`) should adopt the
  same above-row pattern; deferred per Q2.
- Mobile-specific tuning for the centered layout (font sizes,
  vertical centering offset for keyboard).
- Animated slide (FLIP / View Transitions) center → bottom if the
  crossfade ever feels insufficient.

# Chat Input Session Draft — Design

**Status:** Draft
**Date:** 2026-06-01
**Owner:** tlgimenes@gmail.com

## Problem

The chat input (`apps/mesh/src/web/components/chat/input.tsx`) keeps the
in-progress Tiptap document in local component state (`tiptapDoc`). When the
user refreshes the page, navigates away and back, or accidentally closes and
reopens the tab in the same browser session, the draft is lost. For threads
that hold conversational context the user was actively building up to, this is
a real productivity hit — especially when a draft contains carefully-composed
text, mentions, or freshly-attached files.

The codebase already persists a Tiptap doc to `sessionStorage` in one specific
case: the home composer's one-shot handoff to a newly-created thread
(`apps/mesh/src/web/lib/autosend.ts`). We will extend the same storage mental
model into a **per-thread continuous draft** so the input survives a refresh
in the same tab.

## Goals

1. While the user is typing in the chat input, persist the current Tiptap doc
   to `sessionStorage`, keyed per thread (or `__home__` for the home composer).
2. On chat input mount (page load / refresh), restore the persisted doc into
   the editor.
3. On successful submit, clear the persisted draft for that thread.
4. Switching between threads in the same tab restores each thread's own
   draft.
5. Failure modes (sessionStorage quota exceeded) do not crash the app, do not
   inconvenience the user with UI, and are observable via PostHog telemetry
   plus a `console.warn` for local debugging.

## Non-goals

- **Long-term draft persistence.** Drafts are explicitly tab-scoped via
  `sessionStorage`. Closing the tab discards drafts. If users later ask for
  "my draft was there yesterday," upgrading the storage tier to `localStorage`
  with TTL+cap is a follow-up, not part of this slice.
- **Cross-tab synchronization.** Two tabs on the same thread each get their
  own draft slot (sessionStorage's natural per-tab isolation). We do not add
  any cross-tab merging.
- **Other chat input changes.** No new modes, affordances, or attachment UX.
  This spec is strictly the draft-persistence behavior; the rest of the input
  stays as-is.
- **Stripping or shrinking file nodes for storage.** We persist the doc
  as-is, including base64-encoded file attachments. If the doc exceeds
  sessionStorage quota, the write silently fails (see Failure handling).
- **Debounced writes.** Each `onUpdate` keystroke triggers a write in v1.
  Telemetry will tell us if we have a perf problem.
- **A "draft saved" indicator.** No checkmark, no "saved at HH:MM" text. The
  feature is invisible when it works.

## Behavior

### When a draft is written

- On every Tiptap `onUpdate` (one per keystroke / content change), the
  current doc is serialized and written to `sessionStorage`.
- If the resulting doc is "empty" (per the existing `isTiptapDocEmpty`
  helper in `apps/mesh/src/web/components/chat/tiptap/utils.ts`), the
  storage entry is **removed** rather than written as an empty payload. This
  avoids leaving stale `{ tiptapDoc: { type: "doc", content: [] } }` entries
  lying around after the user clears the input.

### When a draft is read

- On `ChatInput` mount, before first render of `TiptapProvider`, the lazy
  `useState` initializer calls `readChatDraft(...)` and uses that as the
  initial value of the local `tiptapDoc` state. The existing prop wiring
  (`TiptapProvider`'s `content: tiptapDoc || ""`) then initializes the
  editor with the restored doc.
- A malformed or absent storage entry returns `null` and the editor starts
  empty. Malformed entries are removed so they don't keep failing parse on
  every mount.

### When a draft is cleared

- **On submit** — both the thread-stream `sendMessage` path and the
  home-composer `homeSubmit` path call `clearChatDraft(...)` after
  dispatching the message. The existing code dispatches optimistically (no
  `await`) and immediately clears local doc state; the new draft clearing
  matches that optimistic semantics. If the network call later fails, the
  user's previously-typed message is already gone from both local state
  and storage — same loss-of-work behavior as today.
- **On thread switch** — the existing `prevTaskRef` block in `ChatInput`
  that wipes local doc state on `taskId` change is **extended** (see
  Architecture > Wiring step 5) to also hydrate the *new* thread's draft
  from storage. `useState`'s lazy initializer fires only on mount, so the
  re-hydration must happen explicitly in the `prevTaskRef` handler. The
  previous thread's draft is left in sessionStorage and will be picked up
  if the user navigates back.
- **On empty doc** — the doc-is-empty check removes the entry (see above).
- **Tab close** — sessionStorage discards everything automatically. No
  cleanup code needed.

### Home composer specifics

- The home composer mounts the same `ChatInput` component without a
  `taskId`. The draft key falls back to the literal string `"__home__"`,
  scoped by `locator`. Two different projects therefore keep separate home
  drafts.
- The home submit flow already writes the doc to `sessionStorage` under
  `chatAutosend(locator, newTaskId)` for the new-thread handoff. The
  `__home__` draft is **also cleared** at submit, so refreshing the home
  page after a submit shows an empty composer rather than the last-sent
  message.
- The autosend payload is consumed on the destination thread page by the
  existing `claimStoredAutosend` flow. Coexistence is naturally safe: the
  two mechanisms use **different keys** with **different lifetimes** and do
  not collide.

## Failure handling

The only expected runtime failure for `sessionStorage.setItem` is
`QuotaExceededError`. This happens when the doc (typically a doc with one or
more large base64-encoded image attachments) exceeds the ~5 MB per-tab
budget. The write is wrapped in `try/catch`:

```ts
try {
  storage.setItem(key, serialized);
} catch (err) {
  if (isQuotaExceededError(err)) {
    track("chat_draft_quota_exceeded", {
      thread_id: taskId ?? null,
      doc_size_bytes: serialized.length,
    });
    console.warn("[chat-draft] quota exceeded; draft not saved", err);
    return;
  }
  throw err; // anything else is unexpected; let it bubble.
}
```

- **No user-facing UI.** No banner, no toast. The user keeps typing; the
  next keystroke will retry the write. If the user removes the
  oversized content (e.g., deletes the large attachment), saving resumes
  naturally — no recovery code needed.
- **Telemetry.** A single PostHog event per failed write. We accept that a
  streak of keystrokes against an oversized doc will spam events; this is
  intentional in v1 so we can measure the real-world rate. A
  "warn-once-per-thread" deduplication can be added later if the volume is
  noisy.
- **`console.warn`** to surface the issue in dev/preview environments
  without alerting on it.
- **Other errors** (security errors from sandboxed contexts, e.g.) are
  re-thrown so we hear about them.

`isQuotaExceededError(err)` checks for either the modern `QuotaExceededError`
name or the legacy Firefox `NS_ERROR_DOM_QUOTA_REACHED` name, since the
catch needs to be robust across browsers.

## Architecture

### New module: `apps/mesh/src/web/lib/chat-draft.ts`

Sibling to the existing `apps/mesh/src/web/lib/autosend.ts`. Deliberately
separate: `autosend.ts` models a *one-shot, TTL'd, status-tracked transfer*,
while `chat-draft.ts` models a *continuous, untimed draft slot*. Merging
them would be premature unification — the lifecycles differ.

Public API:

```ts
import type { ProjectLocator } from "@decocms/mesh-sdk";
import type { Metadata } from "@/web/components/chat/types";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const HOME_DRAFT_KEY = "__home__";

export interface StoredChatDraft {
  tiptapDoc: Metadata["tiptapDoc"];
  updatedAt: number;
}

/** Writes the doc, or clears the entry if the doc is empty. */
export function writeChatDraft(
  storage: StorageLike,
  locator: ProjectLocator | string,
  taskKey: string,
  tiptapDoc: Metadata["tiptapDoc"],
): void;

/** Reads the doc or returns null. Removes malformed entries. */
export function readChatDraft(
  storage: StorageLike,
  locator: ProjectLocator | string,
  taskKey: string,
): Metadata["tiptapDoc"] | null;

/** Removes the entry unconditionally. */
export function clearChatDraft(
  storage: StorageLike,
  locator: ProjectLocator | string,
  taskKey: string,
): void;
```

`StorageLike` mirrors the existing `autosend.ts` shape so unit tests can
inject an in-memory storage object.

### New entry in `LOCALSTORAGE_KEYS`

In `apps/mesh/src/web/lib/localstorage-keys.ts`, add next to `chatAutosend`:

```ts
chatDraft: (locator: ProjectLocator | string, taskKey: string) =>
  `mesh:chat:draft:${locator}:${taskKey}`,
```

The `taskKey` parameter accepts either a real `taskId` (UUID) or the
literal `HOME_DRAFT_KEY` value `"__home__"`. The function does not
discriminate — both are just strings to the storage layer.

### Wiring in `apps/mesh/src/web/components/chat/input.tsx`

The only React component touched. Five concrete changes inside
`ChatInput`:

1. **Compute the draft key:**
   ```ts
   const draftKey = taskId || HOME_DRAFT_KEY;
   ```
   Placed after `taskId` is destructured from `taskCtx`.

2. **Hydrate initial state from storage:**
   ```ts
   const [tiptapDoc, setTiptapDocLocal] = useState<Metadata["tiptapDoc"]>(
     () => readChatDraft(sessionStorage, locator, draftKey) ?? undefined,
   );
   ```
   The lazy initializer runs once on mount. `locator` is already available
   from `useProjectContext()`.

3. **Persist on every update:**
   The existing `setTiptapDoc` wrapper now also writes:
   ```ts
   const setTiptapDoc = (doc: Metadata["tiptapDoc"]) => {
     setTiptapDocLocal(doc);
     tiptapDocRef.current = doc;
     writeChatDraft(sessionStorage, locator, draftKey, doc);
   };
   ```
   `writeChatDraft` is responsible for the empty-doc removal and the
   quota-exceeded swallow.

4. **Clear on submit:**
   In `handleSubmit`, in the `canSubmit && tiptapDoc` branch, after the
   `stream.sendMessage` / `homeSubmit` dispatch and before
   `setTiptapDoc(undefined)`:
   ```ts
   clearChatDraft(sessionStorage, locator, draftKey);
   ```
   The subsequent `setTiptapDoc(undefined)` call would also clear via the
   empty-doc branch, but explicit clear at submit time is clearer about
   intent.

5. **Task-switch reset:**
   The existing `prevTaskRef` block (lines 320–328) currently resets the
   local doc to `undefined` when `taskId` changes. Because `useState`'s
   lazy initializer only fires on mount (not on prop change), the block is
   **extended** to additionally hydrate the new thread's draft from
   storage:
   ```ts
   if (prevTaskRef.current !== taskId) {
     prevTaskRef.current = taskId;
     const newKey = taskId || HOME_DRAFT_KEY;
     const restored = readChatDraft(sessionStorage, locator, newKey);
     setTiptapDocLocal(restored ?? undefined);
     tiptapDocRef.current = restored ?? undefined;
   }
   ```
   This preserves the "previous thread's draft stays in storage" behavior
   while restoring the new thread's draft. `TiptapProvider` already
   remounts via `key={taskId}` and accepts `tiptapDoc` as initial content,
   so the restored doc flows into the editor on the new render.

### What stays unchanged

- `TiptapProvider`, `TiptapInput`, `FileNode`, `FileUploader`, mention
  nodes — untouched.
- The existing `autosend` module and its storage key — untouched. We do
  *not* try to unify with it.
- The `prevTaskRef` reset block's existence and timing — only its body is
  edited (to additionally hydrate from storage).
- All other `ChatInput` behavior: voice input, file drag/drop, model
  selection, chat mode pills, send-button morph, etc.

## Testing

Per `TESTING.md`: two tiers.

### Unit tests — `apps/mesh/src/web/lib/chat-draft.test.ts`

Co-located, no mocks, in-memory `StorageLike` map:

- `writeChatDraft` writes a JSON-encoded `{ tiptapDoc, updatedAt }` payload
  to the expected key.
- `writeChatDraft` removes the key when given a doc considered empty by
  `isTiptapDocEmpty`.
- `writeChatDraft` writes a doc containing file nodes (with base64
  `data`) intact.
- `writeChatDraft` swallows `QuotaExceededError` (simulated by a
  `StorageLike` whose `setItem` throws) and does **not** rethrow; the
  payload is *not* written.
- `writeChatDraft` rethrows non-quota storage errors.
- `readChatDraft` returns the doc for a well-formed entry.
- `readChatDraft` returns `null` and *removes the key* for a malformed JSON
  entry.
- `readChatDraft` returns `null` for a missing key.
- `clearChatDraft` removes the key.
- `HOME_DRAFT_KEY` produces a stable, locator-scoped key when combined with
  `LOCALSTORAGE_KEYS.chatDraft(locator, HOME_DRAFT_KEY)`.

Quota detection covers both `QuotaExceededError` (modern) and
`NS_ERROR_DOM_QUOTA_REACHED` (Firefox legacy).

### E2E tests — `apps/mesh/e2e/tests/`

Playwright, real stack:

1. **Thread draft survives refresh.** Open a thread, type a message into
   the input (no submit), reload the page → message text is restored.
2. **Home composer draft survives refresh.** On the home page, type a
   message, reload → text is restored.
3. **Submit clears the draft.** Type a message, submit, wait for response
   to start, reload → input is empty.
4. **Per-thread isolation.** Type a draft in thread A. Navigate to thread B
   (same tab). Type a different draft in B. Navigate back to A → A's draft
   is restored, not B's.

We deliberately do **not** e2e the quota-exceeded path. Provoking a real
QuotaExceededError reliably across browsers requires either monkeypatching
`Storage` (not e2e in spirit) or generating multi-megabyte file
attachments (slow, flaky). The unit test covers the catch-block contract,
and PostHog will surface the real-world rate.

## Telemetry

One new event:

- `chat_draft_quota_exceeded`
  - `thread_id`: string | null — the task id, or `null` for the home composer.
  - `doc_size_bytes`: number — the size of the JSON payload that failed to
    write.

Tracked once per failed `setItem` call. Volume can be deduplicated later if
this is too noisy.

## Rollout

- No feature flag. The change is local to one component plus one new
  module; the blast radius is bounded.
- The fix is purely client-side. No migration. No backend coordination.
- The PR can ship behind no gate; first user benefit is on first deploy.

## Open questions

None at design time. Implementation will surface any.

## Follow-ups (out of scope here)

- Upgrade to `localStorage` + TTL + size cap if users want drafts across
  tab close / browser restart.
- "Warn once per thread" dedup for `chat_draft_quota_exceeded` if telemetry
  shows excessive volume.
- A small "draft saved" indicator if user research surfaces uncertainty
  about whether autosave is on.
- A debounce on the write path if perf profiling shows keystroke overhead
  on very large docs.

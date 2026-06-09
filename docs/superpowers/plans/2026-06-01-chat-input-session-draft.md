# Chat Input Session Draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat input survive a page refresh by persisting the in-progress Tiptap doc to `sessionStorage`, keyed per thread (and `"__home__"` for the home composer), and restoring it on mount. On submit, the draft is cleared.

**Architecture:** One new pure helper module (`chat-draft.ts`) sibling to the existing `autosend.ts`, deliberately separate because the autosend mechanism is a one-shot TTL'd transfer while drafts are continuous. Wiring into the React component happens in five small, localized edits to `ChatInput` in `apps/mesh/src/web/components/chat/input.tsx`. Telemetry for the `QuotaExceededError` path is injected via an optional callback so the helper module stays free of `posthog-js`, keeping unit tests pure (no browser-only deps in the test loader).

**Tech Stack:** TypeScript 5.9, React 19, Tiptap, Bun test runner (unit), Playwright (e2e), `@/web/lib/posthog-client` `track()` (telemetry).

**Source spec:** [`docs/superpowers/specs/2026-06-01-chat-input-session-draft-design.md`](../specs/2026-06-01-chat-input-session-draft-design.md)

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `apps/mesh/src/web/lib/localstorage-keys.ts` | modify | Add `chatDraft(locator, taskKey)` entry to the well-known keys registry. |
| `apps/mesh/src/web/lib/chat-draft.ts` | create | Pure storage helper. Exports `HOME_DRAFT_KEY`, `writeChatDraft`, `readChatDraft`, `clearChatDraft`, `isQuotaExceededError`. No React, no `posthog-js` imports. |
| `apps/mesh/src/web/lib/chat-draft.test.ts` | create | Bun unit tests against an in-memory `StorageLike`. Mirrors `autosend.test.ts` shape. |
| `apps/mesh/src/web/components/chat/input.tsx` | modify | Wire the helper into `ChatInput`: lazy hydrate, write on update, clear on submit, hydrate on task switch. |
| `apps/mesh/e2e/tests/chat-input-draft.spec.ts` | create | Four Playwright UI tests covering thread/home refresh, submit-clears, and per-thread isolation. |

The helper module is intentionally small and free of side-effectful imports so it's trivially unit-testable. The component file already orchestrates the input lifecycle; this plan only adds five short blocks to it.

---

## Task 1: Add `chatDraft` to `LOCALSTORAGE_KEYS`

**Files:**
- Modify: `apps/mesh/src/web/lib/localstorage-keys.ts`

- [ ] **Step 1: Open the file and read the existing shape**

The file is short and declares a single `LOCALSTORAGE_KEYS` const object. The new entry lives directly under `chatAutosend` to keep chat-related keys grouped.

- [ ] **Step 2: Add the new key entry**

Edit `apps/mesh/src/web/lib/localstorage-keys.ts`. Find this existing line:

```ts
  chatAutosend: (locator: ProjectLocator | string, taskId: string) =>
    `mesh:chat:autosend:${locator}:${taskId}`,
```

Insert the new entry directly after it:

```ts
  chatDraft: (locator: ProjectLocator | string, taskKey: string) =>
    `mesh:chat:draft:${locator}:${taskKey}`,
```

The `taskKey` parameter accepts either a real `taskId` (UUID) or the `HOME_DRAFT_KEY` literal `"__home__"` — both are just strings to the storage layer.

- [ ] **Step 3: Verify TypeScript still compiles**

Run: `bun run check`

Expected: no new errors. (Any pre-existing errors that exist on the branch are unrelated to this change and should be ignored for this step.)

- [ ] **Step 4: Run formatter**

Run: `bun run fmt`

Expected: file is formatted; no other diffs.

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/web/lib/localstorage-keys.ts
git commit -m "feat(chat): add chatDraft key to LOCALSTORAGE_KEYS"
```

---

## Task 2: Create `chat-draft.ts` (pure helper) with unit tests (TDD)

**Files:**
- Create: `apps/mesh/src/web/lib/chat-draft.ts`
- Create: `apps/mesh/src/web/lib/chat-draft.test.ts`

Use TDD: write the failing test file first, watch it fail, then implement the module.

- [ ] **Step 1: Write the failing test file**

Create `apps/mesh/src/web/lib/chat-draft.test.ts` with this content:

```ts
import { describe, expect, test } from "bun:test";
import { LOCALSTORAGE_KEYS } from "./localstorage-keys";
import {
  HOME_DRAFT_KEY,
  clearChatDraft,
  isQuotaExceededError,
  readChatDraft,
  writeChatDraft,
} from "./chat-draft";
import type { TiptapDoc } from "@/web/components/chat/types";

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  /** Test-only: assert raw storage contents. */
  has(key: string) {
    return this.items.has(key);
  }
}

/** Storage that throws QuotaExceededError on setItem. */
class QuotaStorage extends MemoryStorage {
  override setItem(_key: string, _value: string): void {
    const err = new Error("quota");
    err.name = "QuotaExceededError";
    throw err;
  }
}

/** Storage that throws a non-quota error on setItem. */
class BrokenStorage extends MemoryStorage {
  override setItem(_key: string, _value: string): void {
    throw new Error("disk on fire");
  }
}

const LOCATOR = "org/project";
const TASK_ID = "task-1";
const KEY = LOCALSTORAGE_KEYS.chatDraft(LOCATOR, TASK_ID);
const HOME_KEY = LOCALSTORAGE_KEYS.chatDraft(LOCATOR, HOME_DRAFT_KEY);

const docWith = (text: string): TiptapDoc => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text }],
    },
  ],
});

const emptyDoc: TiptapDoc = { type: "doc", content: [] };

describe("chat-draft storage", () => {
  test("writeChatDraft persists doc as JSON payload with updatedAt", () => {
    const storage = new MemoryStorage();
    writeChatDraft(storage, LOCATOR, TASK_ID, docWith("hello"));
    const raw = storage.getItem(KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.tiptapDoc).toEqual(docWith("hello"));
    expect(typeof parsed.updatedAt).toBe("number");
  });

  test("readChatDraft round-trips a written doc", () => {
    const storage = new MemoryStorage();
    writeChatDraft(storage, LOCATOR, TASK_ID, docWith("hello"));
    expect(readChatDraft(storage, LOCATOR, TASK_ID)).toEqual(docWith("hello"));
  });

  test("writeChatDraft removes the key when given an empty doc", () => {
    const storage = new MemoryStorage();
    writeChatDraft(storage, LOCATOR, TASK_ID, docWith("hello"));
    expect(storage.has(KEY)).toBe(true);
    writeChatDraft(storage, LOCATOR, TASK_ID, emptyDoc);
    expect(storage.has(KEY)).toBe(false);
  });

  test("writeChatDraft removes the key when given undefined", () => {
    const storage = new MemoryStorage();
    writeChatDraft(storage, LOCATOR, TASK_ID, docWith("hello"));
    writeChatDraft(storage, LOCATOR, TASK_ID, undefined);
    expect(storage.has(KEY)).toBe(false);
  });

  test("writeChatDraft persists docs containing file nodes intact", () => {
    const storage = new MemoryStorage();
    const docWithFile: TiptapDoc = {
      type: "doc",
      content: [
        {
          type: "file",
          attrs: {
            id: "f1",
            name: "screenshot.png",
            mimeType: "image/png",
            size: 12,
            data: "iVBORw0KGgo=",
          },
        },
      ],
    };
    writeChatDraft(storage, LOCATOR, TASK_ID, docWithFile);
    expect(readChatDraft(storage, LOCATOR, TASK_ID)).toEqual(docWithFile);
  });

  test("writeChatDraft swallows QuotaExceededError, invokes callback", () => {
    const storage = new QuotaStorage();
    const calls: Array<{ docSizeBytes: number }> = [];
    expect(() =>
      writeChatDraft(storage, LOCATOR, TASK_ID, docWith("hello"), {
        onQuotaExceeded: (info) => calls.push(info),
      }),
    ).not.toThrow();
    expect(calls.length).toBe(1);
    expect(calls[0].docSizeBytes).toBeGreaterThan(0);
  });

  test("writeChatDraft is safe when no callback provided on quota error", () => {
    const storage = new QuotaStorage();
    expect(() =>
      writeChatDraft(storage, LOCATOR, TASK_ID, docWith("hello")),
    ).not.toThrow();
  });

  test("writeChatDraft rethrows non-quota storage errors", () => {
    const storage = new BrokenStorage();
    expect(() =>
      writeChatDraft(storage, LOCATOR, TASK_ID, docWith("hello")),
    ).toThrow(/disk on fire/);
  });

  test("readChatDraft returns null for a missing key", () => {
    const storage = new MemoryStorage();
    expect(readChatDraft(storage, LOCATOR, TASK_ID)).toBeNull();
  });

  test("readChatDraft removes and returns null for malformed JSON", () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY, "not json");
    expect(readChatDraft(storage, LOCATOR, TASK_ID)).toBeNull();
    expect(storage.has(KEY)).toBe(false);
  });

  test("readChatDraft removes and returns null for shape mismatch", () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY, JSON.stringify({ wrong: "shape" }));
    expect(readChatDraft(storage, LOCATOR, TASK_ID)).toBeNull();
    expect(storage.has(KEY)).toBe(false);
  });

  test("clearChatDraft removes the key", () => {
    const storage = new MemoryStorage();
    writeChatDraft(storage, LOCATOR, TASK_ID, docWith("hi"));
    clearChatDraft(storage, LOCATOR, TASK_ID);
    expect(storage.has(KEY)).toBe(false);
  });

  test("HOME_DRAFT_KEY scopes the home composer draft by locator", () => {
    const storage = new MemoryStorage();
    writeChatDraft(storage, LOCATOR, HOME_DRAFT_KEY, docWith("home"));
    expect(storage.has(HOME_KEY)).toBe(true);
    expect(readChatDraft(storage, LOCATOR, HOME_DRAFT_KEY)).toEqual(
      docWith("home"),
    );
  });
});

describe("isQuotaExceededError", () => {
  test("matches modern QuotaExceededError by name", () => {
    const err = new Error("over");
    err.name = "QuotaExceededError";
    expect(isQuotaExceededError(err)).toBe(true);
  });

  test("matches legacy Firefox NS_ERROR_DOM_QUOTA_REACHED by name", () => {
    const err = new Error("over");
    err.name = "NS_ERROR_DOM_QUOTA_REACHED";
    expect(isQuotaExceededError(err)).toBe(true);
  });

  test("rejects unrelated errors", () => {
    expect(isQuotaExceededError(new Error("nope"))).toBe(false);
    expect(isQuotaExceededError("string")).toBe(false);
    expect(isQuotaExceededError(null)).toBe(false);
    expect(isQuotaExceededError(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test apps/mesh/src/web/lib/chat-draft.test.ts`

Expected: every test fails to import `./chat-draft` (module does not yet exist). The error is "Cannot find module './chat-draft'" or similar.

- [ ] **Step 3: Implement `chat-draft.ts`**

Create `apps/mesh/src/web/lib/chat-draft.ts` with this content:

```ts
import type { ProjectLocator } from "@decocms/mesh-sdk";
import type { TiptapDoc } from "@/web/components/chat/types";
import { isTiptapDocEmpty } from "@/web/components/chat/tiptap/utils";
import { LOCALSTORAGE_KEYS } from "./localstorage-keys";

/**
 * Stand-in `taskKey` for the home composer (no taskId exists yet). The key
 * is scoped by `locator` so two projects keep separate home drafts.
 */
export const HOME_DRAFT_KEY = "__home__";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface StoredChatDraft {
  tiptapDoc: TiptapDoc;
  updatedAt: number;
}

export interface WriteChatDraftOptions {
  /**
   * Called when a write fails with QuotaExceededError. Receives the size
   * of the payload that failed to write so the caller can surface
   * telemetry. Not called for other errors (those are re-thrown).
   */
  onQuotaExceeded?: (info: { docSizeBytes: number }) => void;
}

function storageKey(
  locator: ProjectLocator | string,
  taskKey: string,
): string {
  return LOCALSTORAGE_KEYS.chatDraft(locator, taskKey);
}

function parseStoredDraft(value: string | null): TiptapDoc | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { updatedAt?: unknown }).updatedAt !== "number"
  ) {
    return null;
  }
  const doc = (parsed as { tiptapDoc?: unknown }).tiptapDoc;
  if (
    !doc ||
    typeof doc !== "object" ||
    (doc as { type?: unknown }).type !== "doc"
  ) {
    return null;
  }
  return doc as TiptapDoc;
}

/**
 * Persists the doc to storage. Removes the entry when the doc is empty.
 * On QuotaExceededError, invokes `options.onQuotaExceeded` (if provided)
 * and swallows the error so typing remains responsive. Re-throws any
 * other storage error.
 */
export function writeChatDraft(
  storage: StorageLike,
  locator: ProjectLocator | string,
  taskKey: string,
  tiptapDoc: TiptapDoc | undefined,
  options?: WriteChatDraftOptions,
): void {
  const key = storageKey(locator, taskKey);

  if (isTiptapDocEmpty(tiptapDoc)) {
    storage.removeItem(key);
    return;
  }

  const payload: StoredChatDraft = {
    tiptapDoc: tiptapDoc as TiptapDoc,
    updatedAt: Date.now(),
  };
  const serialized = JSON.stringify(payload);

  try {
    storage.setItem(key, serialized);
  } catch (err) {
    if (isQuotaExceededError(err)) {
      options?.onQuotaExceeded?.({ docSizeBytes: serialized.length });
      return;
    }
    throw err;
  }
}

/**
 * Returns the persisted doc, or `null` if no valid draft exists. Malformed
 * entries are removed in passing so they don't keep failing parse on each
 * mount.
 */
export function readChatDraft(
  storage: StorageLike,
  locator: ProjectLocator | string,
  taskKey: string,
): TiptapDoc | null {
  const key = storageKey(locator, taskKey);
  const raw = storage.getItem(key);
  const doc = parseStoredDraft(raw);
  if (raw !== null && doc === null) {
    storage.removeItem(key);
  }
  return doc;
}

/** Removes the draft for the given key. No-op if absent. */
export function clearChatDraft(
  storage: StorageLike,
  locator: ProjectLocator | string,
  taskKey: string,
): void {
  storage.removeItem(storageKey(locator, taskKey));
}

/**
 * True if `err` is a sessionStorage/localStorage quota error. Handles both
 * the modern `QuotaExceededError` and the legacy Firefox name
 * `NS_ERROR_DOM_QUOTA_REACHED`.
 */
export function isQuotaExceededError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return (
    name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED"
  );
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test apps/mesh/src/web/lib/chat-draft.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Run `bun run check` to confirm types**

Run: `bun run check`

Expected: no new TypeScript errors from `chat-draft.ts` or `chat-draft.test.ts`.

- [ ] **Step 6: Format**

Run: `bun run fmt`

- [ ] **Step 7: Commit**

```bash
git add apps/mesh/src/web/lib/chat-draft.ts apps/mesh/src/web/lib/chat-draft.test.ts
git commit -m "feat(chat): add chat-draft sessionStorage helper

Pure helper for persisting and restoring the Tiptap composer doc per
thread. QuotaExceededError is reported via an injected callback so the
helper stays free of posthog-js and unit-testable."
```

---

## Task 3: Wire `chat-draft.ts` into `ChatInput`

**Files:**
- Modify: `apps/mesh/src/web/components/chat/input.tsx`

This task does five small edits. After each, the dev server should still compile.

- [ ] **Step 1: Add the imports**

Find this existing block at the top of `apps/mesh/src/web/components/chat/input.tsx` (around lines 1–62) and add two imports:

1. Locate the existing import:
   ```ts
   import { track } from "@/web/lib/posthog-client";
   ```
   This is already present — keep as-is.

2. Add a new import directly under the existing `import { ... writeStoredAutosend } from "@/web/lib/autosend";` line:
   ```ts
   import {
     HOME_DRAFT_KEY,
     clearChatDraft,
     readChatDraft,
     writeChatDraft,
   } from "@/web/lib/chat-draft";
   ```

- [ ] **Step 2: Extract `locator` from `useProjectContext` in `ChatInput`**

Find this existing line in `ChatInput` (around line 254):

```ts
  const { org } = useProjectContext();
```

Replace with:

```ts
  const { org, locator } = useProjectContext();
```

(`locator` is already a valid field on the `useProjectContext()` return — `useHomeSubmit` higher up in the file already destructures it.)

- [ ] **Step 3: Compute `draftKey` once per render**

Find this existing line in `ChatInput` (around line 239):

```ts
  const taskId = taskCtx?.taskId ?? "";
```

Add immediately after (before the existing `const homeSubmit = useHomeSubmit();`):

```ts
  // Storage key for the per-thread (or home composer) draft.
  const draftKey = taskId || HOME_DRAFT_KEY;
```

- [ ] **Step 4: Lazy-hydrate `tiptapDoc` from storage on mount**

Find this existing block (around lines 311–313):

```ts
  // tiptapDoc lives here (not in context) so keystrokes don't re-render
  // the entire context tree. The ref on context lets IceBreakers read it.
  const [tiptapDoc, setTiptapDocLocal] =
    useState<Metadata["tiptapDoc"]>(undefined);
```

Replace with:

```ts
  // tiptapDoc lives here (not in context) so keystrokes don't re-render
  // the entire context tree. The ref on context lets IceBreakers read it.
  // The lazy initializer hydrates the draft from sessionStorage on mount.
  const [tiptapDoc, setTiptapDocLocal] = useState<Metadata["tiptapDoc"]>(
    () => readChatDraft(sessionStorage, locator, draftKey) ?? undefined,
  );
```

- [ ] **Step 5: Persist on every update inside `setTiptapDoc`**

Find this existing block (around lines 314–317):

```ts
  const setTiptapDoc = (doc: Metadata["tiptapDoc"]) => {
    setTiptapDocLocal(doc);
    tiptapDocRef.current = doc;
  };
```

Replace with:

```ts
  const setTiptapDoc = (doc: Metadata["tiptapDoc"]) => {
    setTiptapDocLocal(doc);
    tiptapDocRef.current = doc;
    writeChatDraft(sessionStorage, locator, draftKey, doc, {
      onQuotaExceeded: ({ docSizeBytes }) => {
        track("chat_draft_quota_exceeded", {
          thread_id: taskId || null,
          doc_size_bytes: docSizeBytes,
        });
        console.warn(
          "[chat-draft] sessionStorage quota exceeded; draft not saved",
        );
      },
    });
  };
```

- [ ] **Step 6: Hydrate the destination draft on thread switch**

Find this existing block (around lines 320–328):

```ts
  // Reset input when switching tasks (TiptapProvider also remounts via key)
  const prevTaskRef = useRef(taskId);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  if (prevTaskRef.current !== taskId) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    prevTaskRef.current = taskId;
    setTiptapDocLocal(undefined);
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    tiptapDocRef.current = undefined;
  }
```

Replace with:

```ts
  // When switching tasks, rehydrate the new task's draft from storage
  // (useState's lazy initializer only fires on mount). The previous
  // task's draft is left in sessionStorage and will be picked up if the
  // user navigates back.
  const prevTaskRef = useRef(taskId);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  if (prevTaskRef.current !== taskId) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    prevTaskRef.current = taskId;
    const restored =
      readChatDraft(sessionStorage, locator, draftKey) ?? undefined;
    setTiptapDocLocal(restored);
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    tiptapDocRef.current = restored;
  }
```

Note: `draftKey` here reflects the *new* `taskId` because it's recomputed at the top of the render. That's why the destination draft is read — not the previous one's.

- [ ] **Step 7: Clear the draft on submit**

Find this existing block inside `handleSubmit` (around lines 385–402, inside the `else if (canSubmit && tiptapDoc)` branch):

```ts
      playClickSound();
      if (stream) {
        void stream.sendMessage(tiptapDoc);
      } else {
        homeSubmit({ tiptapDoc, virtualMcp: selectedVirtualMcp });
      }
      setTiptapDoc(undefined);
```

Replace with:

```ts
      playClickSound();
      if (stream) {
        void stream.sendMessage(tiptapDoc);
      } else {
        homeSubmit({ tiptapDoc, virtualMcp: selectedVirtualMcp });
      }
      clearChatDraft(sessionStorage, locator, draftKey);
      setTiptapDoc(undefined);
```

The subsequent `setTiptapDoc(undefined)` call would also clear the draft (because `writeChatDraft` removes the key on an empty doc), but the explicit `clearChatDraft` keeps intent visible and survives any future refactor of the empty-doc branch.

- [ ] **Step 8: Type-check, format, and verify**

Run: `bun run check`

Expected: no new TypeScript errors. (`writeChatDraft`'s `tiptapDoc` parameter is `TiptapDoc | undefined`, and `Metadata["tiptapDoc"]` is `TiptapDoc | undefined` — same type, so no cast is needed.)

Run: `bun run fmt`

Run: `bun run lint`

Expected: no new lint errors.

- [ ] **Step 9: Smoke-check manually (optional but encouraged)**

Run the dev server, open a thread, type a few words, refresh — the text should reappear. If it doesn't, the wiring is wrong; fix before moving on.

```bash
bun run dev
# Visit http://localhost:4000, sign in, type in the chat input,
# hit Cmd+R, confirm the text is restored. Then submit and refresh — input
# should be empty.
```

- [ ] **Step 10: Commit**

```bash
git add apps/mesh/src/web/components/chat/input.tsx
git commit -m "feat(chat): persist composer draft to sessionStorage per thread

Hydrates the Tiptap doc from sessionStorage on mount and on thread
switch; writes on every update; clears on submit. QuotaExceededError
emits a PostHog event + console.warn and is swallowed so typing
remains responsive."
```

---

## Task 4: End-to-end Playwright tests

**Files:**
- Create: `apps/mesh/e2e/tests/chat-input-draft.spec.ts`

Four scenarios in one spec file, sharing setup. The codebase has no prior UI-driving Playwright tests for the chat input, so this file establishes the pattern.

Key implementation details verified from the codebase:

- The Tiptap editor is a contenteditable with `[data-chat-input="true"]` (set in `apps/mesh/src/web/components/chat/tiptap/input.tsx`, around line 84).
- `apps/mesh/e2e/fixtures/test.ts` exports an `authedPage` fixture that produces a `Page` already signed in, plus `orgSlug`. Use this instead of `@playwright/test`.
- A new thread is created by typing in the home composer and submitting — this both fires `homeSubmit` and navigates the page to `/<orgSlug>/<taskId>`. We use this to obtain a real `taskId` for tests.

- [ ] **Step 1: Create the spec file**

Create `apps/mesh/e2e/tests/chat-input-draft.spec.ts` with this content:

```ts
/**
 * E2E: chat input draft persistence to sessionStorage.
 *
 * Drives the real browser end-to-end. Confirms:
 *   1. Thread drafts survive page refresh.
 *   2. Home composer drafts survive page refresh.
 *   3. Successful submit clears the draft.
 *   4. Drafts are isolated per thread.
 *
 * The quota-exceeded path is deliberately NOT exercised here — it's
 * covered by unit tests on the chat-draft helper. PostHog telemetry will
 * surface real-world occurrence in production.
 */

import { expect, test } from "../fixtures/test";
import type { Page } from "@playwright/test";

const CHAT_INPUT = '[data-chat-input="true"]';

/** Focus the chat input and type via the keyboard. Tiptap is contenteditable, so we cannot use `fill`. */
async function typeInComposer(page: Page, text: string): Promise<void> {
  const input = page.locator(CHAT_INPUT);
  await input.click();
  await page.keyboard.type(text);
}

/** Read the visible text content of the chat input. */
async function composerText(page: Page): Promise<string> {
  return (await page.locator(CHAT_INPUT).innerText()).trim();
}

/** Clear the chat input by selecting all and deleting. */
async function clearComposer(page: Page): Promise<void> {
  await page.locator(CHAT_INPUT).click();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.press("Delete");
}

/** Submit by pressing Enter (no Shift). */
async function submitComposer(page: Page): Promise<void> {
  await page.locator(CHAT_INPUT).click();
  await page.keyboard.press("Enter");
}

/** Type a message in the home composer, submit, and wait until URL contains a taskId. Returns the taskId. */
async function openNewThread(
  page: Page,
  orgSlug: string,
  seed: string,
): Promise<string> {
  await page.goto(`/${orgSlug}`);
  await expect(page.locator(CHAT_INPUT)).toBeVisible();
  await typeInComposer(page, seed);
  await submitComposer(page);
  // After submit, the URL becomes /<orgSlug>/<taskId> via homeSubmit's
  // navigate() call. Wait for it.
  await page.waitForURL(
    (url) => new URL(url).pathname.startsWith(`/${orgSlug}/`),
    { timeout: 20_000 },
  );
  const match = new URL(page.url()).pathname.match(
    new RegExp(`^/${orgSlug}/([^/]+)`),
  );
  if (!match) throw new Error(`could not extract taskId from ${page.url()}`);
  return match[1];
}

test.describe("chat input draft persistence", () => {
  test("thread draft survives page refresh", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    await openNewThread(page, orgSlug, "kick off");

    await expect(page.locator(CHAT_INPUT)).toBeVisible();
    await clearComposer(page);
    await typeInComposer(page, "draft message that should survive");

    await page.reload();

    await expect(page.locator(CHAT_INPUT)).toBeVisible();
    expect(await composerText(page)).toBe(
      "draft message that should survive",
    );
  });

  test("home composer draft survives page refresh", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    await page.goto(`/${orgSlug}`);
    await expect(page.locator(CHAT_INPUT)).toBeVisible();

    await typeInComposer(page, "home composer draft");

    await page.reload();

    await expect(page.locator(CHAT_INPUT)).toBeVisible();
    expect(await composerText(page)).toBe("home composer draft");
  });

  test("submit clears the draft", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    const taskId = await openNewThread(page, orgSlug, "first");

    // Type a second message and submit it (clearing should fire).
    await expect(page.locator(CHAT_INPUT)).toBeVisible();
    await clearComposer(page);
    await typeInComposer(page, "this should be cleared after submit");
    await submitComposer(page);

    // Reload and confirm the input is empty.
    await page.goto(`/${orgSlug}/${taskId}`);
    await expect(page.locator(CHAT_INPUT)).toBeVisible();
    expect(await composerText(page)).toBe("");
  });

  test("drafts are isolated per thread", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    const taskA = await openNewThread(page, orgSlug, "thread a");
    await expect(page.locator(CHAT_INPUT)).toBeVisible();
    await clearComposer(page);
    await typeInComposer(page, "draft for A");

    // Navigate to the home composer to start a second thread.
    const taskB = await openNewThread(page, orgSlug, "thread b");
    await expect(page.locator(CHAT_INPUT)).toBeVisible();
    await clearComposer(page);
    await typeInComposer(page, "draft for B");

    // Switch back to A: A's draft should still be there.
    await page.goto(`/${orgSlug}/${taskA}`);
    await expect(page.locator(CHAT_INPUT)).toBeVisible();
    expect(await composerText(page)).toBe("draft for A");

    // Switch to B: B's draft should still be there.
    await page.goto(`/${orgSlug}/${taskB}`);
    await expect(page.locator(CHAT_INPUT)).toBeVisible();
    expect(await composerText(page)).toBe("draft for B");
  });
});
```

- [ ] **Step 2: Run the spec**

Run the e2e suite for this spec only. Follow whatever Playwright invocation the rest of the e2e suite uses — check `apps/mesh/package.json` `scripts` and the project root `package.json` if unsure. A common command shape is:

```bash
bun run --cwd apps/mesh test:e2e -- chat-input-draft.spec.ts
```

If that script doesn't exist on this branch, run Playwright directly from `apps/mesh`:

```bash
cd apps/mesh && bunx playwright test e2e/tests/chat-input-draft.spec.ts
```

Expected: all four tests pass.

If a test fails:
- **"chat input not visible"** → ensure `bun run dev` (or whatever dev/test server the e2e config uses) is up. Inspect the failure screenshot/video Playwright writes to `apps/mesh/playwright-report/` or the configured `outputDir`.
- **"text was empty after reload"** → the wiring step in Task 3 (most likely the lazy initializer or the empty-doc clear) is broken. Re-check those changes against the plan.
- **"openNewThread couldn't extract taskId from URL"** → the submit didn't navigate, or the URL shape is different in this build. Print `page.url()` and reconcile with the route definition.

- [ ] **Step 3: Type-check, format, lint**

Run: `bun run check`
Run: `bun run fmt`
Run: `bun run lint`

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/e2e/tests/chat-input-draft.spec.ts
git commit -m "test(chat): e2e for sessionStorage draft persistence"
```

---

## Task 5: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit test suite**

Run: `bun test`

Expected: full green. If something unrelated fails, surface it — it's not from this change.

- [ ] **Step 2: Type-check the whole monorepo**

Run: `bun run check`

Expected: no new errors introduced by this branch.

- [ ] **Step 3: Lint**

Run: `bun run lint`

Expected: clean.

- [ ] **Step 4: Format-check**

Run: `bun run fmt:check`

Expected: clean. (If not, run `bun run fmt` and amend the previous commit, or — since the rule is "no amend" per CLAUDE.md — create a follow-up "[chore]: fmt" commit.)

- [ ] **Step 5: Manual sanity check (recommended)**

Spin up the dev server one more time:

```bash
bun run dev
```

Walk through these flows:
1. Open the app, type in the home composer, refresh → text returns.
2. Submit from home → lands on a new thread. Type a draft, refresh → text returns.
3. Submit on the thread → the draft is gone after reload.
4. Open a second thread (Cmd+N or via the sidebar / home composer), type a different draft, navigate back to the first thread → the first thread's draft is intact.
5. Close the tab, reopen the URL → drafts are gone (this is the expected `sessionStorage` behavior).

- [ ] **Step 6: Push the branch and open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(chat): persist composer draft to sessionStorage per thread" \
  --body "$(cat <<'EOF'
## Summary
- Persists the Tiptap composer doc to `sessionStorage` keyed per thread (and `__home__` for the home composer).
- Restores the draft on chat input mount and on thread switch.
- Clears on submit.
- `QuotaExceededError` is swallowed; we emit a PostHog event and `console.warn` so we can debug later.

Spec: docs/superpowers/specs/2026-06-01-chat-input-session-draft-design.md
Plan: docs/superpowers/plans/2026-06-01-chat-input-session-draft.md

## Test plan
- [ ] `bun test apps/mesh/src/web/lib/chat-draft.test.ts` is green.
- [ ] `bun run --cwd apps/mesh test:e2e -- chat-input-draft.spec.ts` (or equivalent) is green locally.
- [ ] Manual: refresh on a thread restores the draft.
- [ ] Manual: refresh on home composer restores the draft.
- [ ] Manual: submit clears the draft.
- [ ] Manual: closing the tab discards the draft (sessionStorage semantics).
EOF
)"
```

---

## Self-Review

Comparing the plan to the spec, section by section:

**Goals:**
- (1) Persist while typing → Task 3, Step 5 (`writeChatDraft` inside `setTiptapDoc`).
- (2) Restore on mount → Task 3, Step 4 (lazy `useState` initializer).
- (3) Clear on submit → Task 3, Step 7 (`clearChatDraft` in `handleSubmit`).
- (4) Per-thread isolation when switching → Task 3, Step 6 (hydrate the new key in the `prevTaskRef` block); covered by E2E test 4.
- (5) Quota-exceeded path is observable, non-fatal → Task 2 (helper swallow + callback); Task 3, Step 5 (telemetry + `console.warn` wired in component).

**Non-goals:** All non-goals from the spec (long-term persistence, cross-tab sync, other chat-input redesigns, file-node stripping, debouncing, "draft saved" indicator) are absent from the plan.

**Architecture/Storage layout:**
- `LOCALSTORAGE_KEYS.chatDraft` added — Task 1.
- New `chat-draft.ts` helper with the API specified (`writeChatDraft`, `readChatDraft`, `clearChatDraft`, plus the new `HOME_DRAFT_KEY` const and `isQuotaExceededError`) — Task 2.
- Wiring in `input.tsx` — Task 3 with the five concrete edits enumerated in the spec.

**Failure handling:** The plan implements the spec's intent (swallow + telemetry + warn) but moves the *call site* of `track()` from the helper to the component, because importing `track` (and thus `posthog-js`) inside a unit-tested helper would diverge from the codebase pattern and risks polluting the Bun test loader. The user-visible behavior is identical. Documented in the plan's Architecture statement.

**Testing:**
- Unit tests: Task 2 — covers all bullets in the spec's unit-test list (write, read, clear, empty doc, file-nodes intact, quota swallow, malformed JSON, key shape).
- E2E tests: Task 4 — all four scenarios from the spec.

**Telemetry:** Event name (`chat_draft_quota_exceeded`) and payload (`thread_id`, `doc_size_bytes`) match the spec — Task 3, Step 5.

**Placeholder scan:** No "TBD", no "add appropriate error handling", no "similar to Task N", no naked "implement later". Every code step contains the actual code. ✅

**Type consistency:** `HOME_DRAFT_KEY` is defined in Task 2's `chat-draft.ts` and imported in Task 3 from `@/web/lib/chat-draft`. `writeChatDraft` signature is consistent across Task 2 (definition + test invocations) and Task 3 (call site). The `onQuotaExceeded` callback shape (`{ docSizeBytes: number }`) matches between Task 2's interface definition and Task 3's call site. ✅

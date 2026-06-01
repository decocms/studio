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

function storageKey(locator: ProjectLocator | string, taskKey: string): string {
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
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

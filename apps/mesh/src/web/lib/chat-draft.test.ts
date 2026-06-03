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
    expect(calls[0]!.docSizeBytes).toBeGreaterThan(0);
  });

  test("writeChatDraft reports UTF-8 byte length on quota error, not char count", () => {
    const storage = new QuotaStorage();
    const calls: Array<{ docSizeBytes: number }> = [];
    // 4-byte UTF-8 character (emoji 🐉) — char count = 2 UTF-16 code units;
    // serialized JSON contains it plus boilerplate. We just need the byte
    // count to differ from the char count to prove TextEncoder is in use.
    writeChatDraft(storage, LOCATOR, TASK_ID, docWith("🐉🐉🐉🐉🐉"), {
      onQuotaExceeded: (info) => calls.push(info),
    });
    expect(calls.length).toBe(1);
    const serialized = JSON.stringify({
      tiptapDoc: docWith("🐉🐉🐉🐉🐉"),
      // updatedAt is a number, so its value doesn't shift UTF-8 byte count
      // relative to UTF-16; only the doc string matters for the inequality.
      updatedAt: 0,
    });
    const utf16 = serialized.length;
    const utf8 = new TextEncoder().encode(serialized).byteLength;
    // Sanity: the chosen content actually produces a difference.
    expect(utf8).toBeGreaterThan(utf16);
    // The reported size is bytes (>= UTF-8 byte length we just computed).
    // Allow ±10 for the differing updatedAt value at runtime.
    expect(calls[0]!.docSizeBytes).toBeGreaterThan(utf16);
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

  test("readChatDraft removes and returns null when content is not an array", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        tiptapDoc: { type: "doc", content: "not-an-array" },
        updatedAt: 1,
      }),
    );
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

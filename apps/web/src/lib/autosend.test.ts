import { describe, expect, test } from "bun:test";
import {
  AUTOSEND_TTL_MS,
  AUTOSEND_QUERY_VALUE,
  autosendStorageKey,
  claimStoredAutosend,
  clearStoredAutosend,
  readStoredAutosend,
  writeStoredAutosend,
  type AutosendPayload,
} from "./autosend";

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
}

describe("autosend storage", () => {
  test("writes and reads a pending payload", () => {
    const storage = new MemoryStorage();
    const payload: AutosendPayload = {
      message: { tiptapDoc: { type: "doc", content: [] } },
      createdAt: 1_700_000_000_000,
    };

    writeStoredAutosend(
      storage,
      "org/project",
      "task-1",
      payload.message,
      payload.createdAt,
    );

    expect(readStoredAutosend(storage, "org/project", "task-1")).toEqual({
      ...payload,
      status: "pending",
    });
  });

  test("claim switches pending payload to sending", () => {
    const storage = new MemoryStorage();
    const payload: AutosendPayload = {
      message: { tiptapDoc: { type: "doc", content: [] } },
      createdAt: 1_700_000_000_000,
    };

    writeStoredAutosend(
      storage,
      "org/project",
      "task-1",
      payload.message,
      payload.createdAt,
    );

    expect(
      claimStoredAutosend(storage, "org/project", "task-1", payload.createdAt),
    ).toEqual(payload);
    expect(readStoredAutosend(storage, "org/project", "task-1")?.status).toBe(
      "sending",
    );
  });

  test("claim ignores non-pending payloads", () => {
    const storage = new MemoryStorage();
    writeStoredAutosend(
      storage,
      "org/project",
      "task-1",
      { tiptapDoc: { type: "doc", content: [] } },
      1_700_000_000_000,
    );
    claimStoredAutosend(storage, "org/project", "task-1", 1_700_000_000_000);

    expect(
      claimStoredAutosend(storage, "org/project", "task-1", 1_700_000_000_000),
    ).toBeNull();
  });

  test("claim removes stale payloads", () => {
    const storage = new MemoryStorage();
    writeStoredAutosend(
      storage,
      "org/project",
      "task-1",
      { tiptapDoc: { type: "doc", content: [] } },
      1_700_000_000_000,
    );

    expect(
      claimStoredAutosend(
        storage,
        "org/project",
        "task-1",
        1_700_000_000_000 + AUTOSEND_TTL_MS,
      ),
    ).toBeNull();
    expect(readStoredAutosend(storage, "org/project", "task-1")).toBeNull();
  });

  test("clear removes the stored payload", () => {
    const storage = new MemoryStorage();
    writeStoredAutosend(
      storage,
      "org/project",
      "task-1",
      { tiptapDoc: { type: "doc", content: [] } },
      1_700_000_000_000,
    );

    clearStoredAutosend(storage, "org/project", "task-1");

    expect(readStoredAutosend(storage, "org/project", "task-1")).toBeNull();
    expect(storage.getItem(autosendStorageKey("org/project", "task-1"))).toBe(
      null,
    );
  });

  test("invalid stored JSON is removed", () => {
    const storage = new MemoryStorage();
    storage.setItem(autosendStorageKey("org/project", "task-1"), "not json");

    expect(readStoredAutosend(storage, "org/project", "task-1")).toBeNull();
    expect(storage.getItem(autosendStorageKey("org/project", "task-1"))).toBe(
      null,
    );
  });

  test("constants match expected URL handoff", () => {
    expect(AUTOSEND_TTL_MS).toBe(10_000);
    expect(AUTOSEND_QUERY_VALUE).toBe("true");
  });
});

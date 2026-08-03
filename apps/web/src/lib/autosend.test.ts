import { describe, expect, test } from "bun:test";
import {
  AUTOSEND_MAX_ATTEMPTS,
  AUTOSEND_TTL_MS,
  AUTOSEND_QUERY_VALUE,
  autosendStorageKey,
  claimStoredAutosend,
  clearStoredAutosend,
  readStoredAutosend,
  restoreStoredAutosend,
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
      attempt: 0,
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
    ).toEqual({ ...payload, attempt: 1 });
    expect(readStoredAutosend(storage, "org/project", "task-1")).toMatchObject({
      status: "sending",
      attempt: 1,
    });
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

  test("claims a pre-attempt payload without changing hosted handoff behavior", () => {
    const storage = new MemoryStorage();
    const createdAt = 1_700_000_000_000;
    storage.setItem(
      autosendStorageKey("org/project", "task-1"),
      JSON.stringify({
        message: { tiptapDoc: { type: "doc", content: [] } },
        createdAt,
        status: "pending",
      }),
    );

    expect(
      claimStoredAutosend(storage, "org/project", "task-1", createdAt),
    ).toMatchObject({ createdAt, attempt: 1 });
  });

  test("does not grant an extra retry to a legacy restored claim", () => {
    const storage = new MemoryStorage();
    const createdAt = 1_700_000_000_000;
    storage.setItem(
      autosendStorageKey("org/project", "task-1"),
      JSON.stringify({
        message: { tiptapDoc: { type: "doc", content: [] } },
        createdAt,
        status: "sending",
        retryAt: createdAt + 1,
      }),
    );

    const migrated = readStoredAutosend(storage, "org/project", "task-1");
    expect(migrated?.attempt).toBe(AUTOSEND_MAX_ATTEMPTS);
    restoreStoredAutosend(
      storage,
      "org/project",
      "task-1",
      createdAt,
      migrated!.attempt,
      createdAt + 2,
    );
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

  test("allows one restored retry across a remount, then exhausts it", () => {
    const storage = new MemoryStorage();
    const createdAt = 1_700_000_000_000;
    writeStoredAutosend(
      storage,
      "org/project",
      "task-1",
      { tiptapDoc: { type: "doc", content: [] } },
      createdAt,
    );
    const firstClaim = claimStoredAutosend(
      storage,
      "org/project",
      "task-1",
      createdAt,
    );
    expect(firstClaim?.attempt).toBe(1);

    restoreStoredAutosend(
      storage,
      "org/project",
      "task-1",
      createdAt + 1,
      firstClaim!.attempt,
    );
    expect(readStoredAutosend(storage, "org/project", "task-1")?.status).toBe(
      "sending",
    );

    const retryAt = createdAt + 1;
    restoreStoredAutosend(
      storage,
      "org/project",
      "task-1",
      createdAt,
      firstClaim!.attempt,
      retryAt,
    );
    expect(readStoredAutosend(storage, "org/project", "task-1")).toMatchObject({
      status: "pending",
      attempt: 1,
      retryAt,
    });

    // A remounted provider can claim the one restored retry.
    const retryClaim = claimStoredAutosend(
      storage,
      "org/project",
      "task-1",
      retryAt,
    );
    expect(retryClaim?.attempt).toBe(AUTOSEND_MAX_ATTEMPTS);

    restoreStoredAutosend(
      storage,
      "org/project",
      "task-1",
      createdAt,
      retryClaim!.attempt,
      retryAt + 1,
    );
    expect(readStoredAutosend(storage, "org/project", "task-1")).toBeNull();
    expect(
      claimStoredAutosend(storage, "org/project", "task-1", retryAt + 2),
    ).toBeNull();
  });

  test("a repeated rejection cannot clear a newer claimed retry", () => {
    const storage = new MemoryStorage();
    const createdAt = 1_700_000_000_000;
    writeStoredAutosend(
      storage,
      "org/project",
      "task-1",
      { tiptapDoc: { type: "doc", content: [] } },
      createdAt,
    );
    const firstClaim = claimStoredAutosend(
      storage,
      "org/project",
      "task-1",
      createdAt,
    )!;
    restoreStoredAutosend(
      storage,
      "org/project",
      "task-1",
      createdAt,
      firstClaim.attempt,
      createdAt + 1,
    );
    const retryClaim = claimStoredAutosend(
      storage,
      "org/project",
      "task-1",
      createdAt + 1,
    )!;

    restoreStoredAutosend(
      storage,
      "org/project",
      "task-1",
      createdAt,
      firstClaim.attempt,
      createdAt + 2,
    );
    expect(readStoredAutosend(storage, "org/project", "task-1")).toMatchObject({
      status: "sending",
      attempt: retryClaim.attempt,
    });

    restoreStoredAutosend(
      storage,
      "org/project",
      "task-1",
      createdAt,
      retryClaim.attempt,
      createdAt + 3,
    );
    expect(readStoredAutosend(storage, "org/project", "task-1")).toBeNull();
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
    expect(AUTOSEND_MAX_ATTEMPTS).toBe(2);
    expect(AUTOSEND_QUERY_VALUE).toBe("true");
  });
});

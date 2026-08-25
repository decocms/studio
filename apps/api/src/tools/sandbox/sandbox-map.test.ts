/**
 * Unit tests for sandboxMap helpers (pure functions).
 */

import { describe, expect, test } from "bun:test";
import type { SandboxRecord } from "@decocms/shared/sdk";

import {
  deleteSandboxMapEntry,
  mergeSandboxMapEntry,
  readSandboxMap,
  resolveVm,
} from "./sandbox-map";

const ENTRY_A: SandboxRecord = {
  sandboxHandle: "vm-1",
  previewUrl: "https://vm-1.deco.studio",
};
const ENTRY_B: SandboxRecord = {
  sandboxHandle: "vm-2",
  previewUrl: "https://vm-2.deco.studio",
};

describe("readSandboxMap", () => {
  test("returns empty object when metadata is null", () => {
    expect(readSandboxMap(null)).toEqual({});
  });

  test("returns empty object when metadata is undefined", () => {
    expect(readSandboxMap(undefined)).toEqual({});
  });

  test("returns empty object when sandboxMap key is missing", () => {
    expect(readSandboxMap({ githubRepo: null })).toEqual({});
  });

  test("returns the sandboxMap when present", () => {
    // 3-level: userId → branch → kind → entry
    const sandboxMap = { "user-1": { main: { "agent-sandbox": ENTRY_A } } };
    expect(readSandboxMap({ sandboxMap })).toEqual(sandboxMap);
  });

  test("returns empty when sandboxMap is not an object", () => {
    expect(readSandboxMap({ sandboxMap: "not an object" })).toEqual({});
  });
});

describe("readSandboxMap canonical reads", () => {
  test("reads the `sandboxMap` key", () => {
    const inner: SandboxRecord = {
      sandboxHandle: "h1",
      previewUrl: null,
      createdAt: 1,
    };
    const meta = {
      sandboxMap: { user1: { main: { "agent-sandbox": inner } } },
    };
    expect(readSandboxMap(meta)).toEqual(meta.sandboxMap);
  });

  test("ignores the legacy `vmMap` key (migration 091 sweeps it away)", () => {
    const inner: SandboxRecord = {
      sandboxHandle: "h1",
      previewUrl: null,
      createdAt: 1,
    };
    const meta = { vmMap: { user1: { main: { "agent-sandbox": inner } } } };
    expect(readSandboxMap(meta)).toEqual({});
  });
});

describe("resolveVm", () => {
  test("returns null when user is absent", () => {
    expect(resolveVm({}, "user-1", "main")).toBeNull();
  });

  test("returns null when branch is absent for that user", () => {
    const sandboxMap = { "user-1": { main: { "agent-sandbox": ENTRY_A } } };
    expect(resolveVm(sandboxMap, "user-1", "feat/x")).toBeNull();
  });

  test("returns the hosted entry when userId and branch are present", () => {
    const sandboxMap = {
      "user-1": {
        main: { "agent-sandbox": ENTRY_A },
        "feat/x": { "agent-sandbox": ENTRY_B },
      },
    };
    expect(resolveVm(sandboxMap, "user-1", "feat/x")).toEqual(ENTRY_B);
  });

  test("isolates users from each other", () => {
    const sandboxMap = {
      "user-1": { main: { "agent-sandbox": ENTRY_A } },
      "user-2": { main: { "agent-sandbox": ENTRY_B } },
    };
    expect(resolveVm(sandboxMap, "user-1", "main")).toEqual(ENTRY_A);
    expect(resolveVm(sandboxMap, "user-2", "main")).toEqual(ENTRY_B);
  });

  test("returns null when the kind is absent but another kind exists", () => {
    const sandboxMap = {
      "user-1": { main: { "local-api": ENTRY_A } },
    };
    // looking up "agent-sandbox" when only "local-api" exists → null
    expect(resolveVm(sandboxMap, "user-1", "main")).toBeNull();
  });

  test("returns the hosted entry when a local sibling coexists", () => {
    const sandboxMap = {
      "user-1": { main: { "local-api": ENTRY_A, "agent-sandbox": ENTRY_B } },
    };
    expect(resolveVm(sandboxMap, "user-1", "main")).toEqual(ENTRY_B);
  });
});

describe("mergeSandboxMapEntry", () => {
  test("preserves sibling branches when adding a new one (switch repos)", () => {
    // Regression: load_repo used to overwrite the whole map, wiping the first
    // repo's entry when a second repo was loaded on the same thread.
    const current = {
      u: { "thread:t/conn_a": { "agent-sandbox": ENTRY_A } },
    };
    const next = mergeSandboxMapEntry(current, "u", "thread:t/conn_b", ENTRY_B);
    expect(resolveVm(next, "u", "thread:t/conn_a")).toEqual(ENTRY_A);
    expect(resolveVm(next, "u", "thread:t/conn_b")).toEqual(ENTRY_B);
  });

  test("preserves sibling kinds on the same branch", () => {
    const current = { u: { b: { "local-api": ENTRY_A } } };
    const next = mergeSandboxMapEntry(current, "u", "b", ENTRY_B);
    expect(next.u?.b?.["local-api"]).toEqual(ENTRY_A);
    expect(resolveVm(next, "u", "b")).toEqual(ENTRY_B);
  });

  test("does not mutate the input map", () => {
    const current = { u: { b: { "agent-sandbox": ENTRY_A } } };
    const snapshot = JSON.stringify(current);
    mergeSandboxMapEntry(current, "u", "b", ENTRY_B);
    expect(JSON.stringify(current)).toBe(snapshot);
  });

  test("normalizes a malformed stringified branch cell instead of corrupting it", () => {
    // parseBranchMap treats a non-object (stringified) cell as empty, so the
    // merge drops the unreadable cell rather than a raw spread exploding it into
    // character-indexed keys ("0","1",...).
    const current = {
      u: { b: JSON.stringify({ "agent-sandbox": ENTRY_A }) },
    } as unknown as Parameters<typeof mergeSandboxMapEntry>[0];
    const next = mergeSandboxMapEntry(current, "u", "b", ENTRY_B);
    expect(resolveVm(next, "u", "b")).toEqual(ENTRY_B);
    expect(next.u?.b).not.toHaveProperty("0");
  });
});

describe("deleteSandboxMapEntry", () => {
  test("returns null when the entry is absent (no-op write)", () => {
    expect(deleteSandboxMapEntry({}, "u", "b")).toBeNull();
    const other = { u: { b: { "local-api": ENTRY_A } } };
    expect(deleteSandboxMapEntry(other, "u", "b")).toBeNull();
  });

  test("removes the entry and prunes empty branch + user buckets", () => {
    const current = { u: { b: { "agent-sandbox": ENTRY_A } } };
    const next = deleteSandboxMapEntry(current, "u", "b");
    expect(next).toEqual({});
  });

  test("keeps sibling kinds and sibling branches", () => {
    const current = {
      u: {
        b: { "agent-sandbox": ENTRY_A, "local-api": ENTRY_B },
        other: { "agent-sandbox": ENTRY_A },
      },
    };
    const next = deleteSandboxMapEntry(current, "u", "b");
    expect(next?.u?.b?.["local-api"]).toEqual(ENTRY_B);
    expect(resolveVm(next!, "u", "other")).toEqual(ENTRY_A);
    expect(resolveVm(next!, "u", "b")).toBeNull();
  });
});

describe("setSandboxMapEntry", () => {
  // Setup: a fake storage adapter that captures the metadata blob written by
  // setSandboxMapEntry so we can assert the new key carries the merged shape.
  test("writes the entry under sandboxMap[user][branch][kind]", async () => {
    const { setSandboxMapEntry } = await import("./sandbox-map");
    const initialMetadata: Record<string, unknown> = {
      sandboxMap: {},
      otherField: "preserved",
    };

    let capturedUpdate: { metadata?: Record<string, unknown> } | null = null;
    const storage = {
      findById: async () => ({ metadata: initialMetadata }),
      update: async (
        _id: string,
        _actingUserId: string,
        data: { metadata?: Record<string, unknown> },
      ) => {
        capturedUpdate = data;
      },
    };

    const newEntry: SandboxRecord = {
      sandboxHandle: "new",
      previewUrl: null,
      createdAt: 2,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await setSandboxMapEntry(
      storage as unknown as import("../../storage/ports").VirtualMCPStoragePort,
      "vmcp_1",
      "u",
      "u",
      "b",
      newEntry,
    );

    expect(capturedUpdate).not.toBeNull();
    const out = capturedUpdate!.metadata as Record<string, unknown>;
    expect("sandboxMap" in out).toBe(true);
    expect(out.otherField).toBe("preserved");
    const sm = out.sandboxMap as Record<
      string,
      Record<string, Record<string, SandboxRecord>>
    >;
    expect(sm.u?.b?.["agent-sandbox"]).toEqual(newEntry);
  });
});

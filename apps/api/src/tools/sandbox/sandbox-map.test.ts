/**
 * Unit tests for sandboxMap helpers (pure functions).
 */

import { describe, expect, test } from "bun:test";
import { parseBranchMap } from "@decocms/shared/sdk";
import type { SandboxMap, SandboxRecord } from "@decocms/shared/sdk";

import {
  deleteAgentSandboxMapEntry,
  mergeAgentSandboxMapEntry,
  readSandboxMap,
} from "./sandbox-map";

const ENTRY_A: SandboxRecord = {
  sandboxHandle: "vm-1",
  previewUrl: "https://vm-1.deco.studio",
};
const ENTRY_B: SandboxRecord = {
  sandboxHandle: "vm-2",
  previewUrl: "https://vm-2.deco.studio",
};
const CANONICAL_ENTRY_B: SandboxRecord = {
  ...ENTRY_B,
  sandboxProviderKind: "agent-sandbox",
};

function entryAt(
  sandboxMap: SandboxMap,
  userId: string,
  branch: string,
  kind: "agent-sandbox" | "user-desktop",
): SandboxRecord | null {
  return parseBranchMap(sandboxMap[userId]?.[branch])[kind] ?? null;
}

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
      sandboxProviderKind: "agent-sandbox",
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
      sandboxProviderKind: "agent-sandbox",
    };
    const meta = { vmMap: { user1: { main: { "agent-sandbox": inner } } } };
    expect(readSandboxMap(meta)).toEqual({});
  });
});

describe("mergeAgentSandboxMapEntry", () => {
  test("preserves sibling branches when adding a new one (switch repos)", () => {
    // Regression: load_repo used to overwrite the whole map, wiping the first
    // repo's entry when a second repo was loaded on the same thread.
    const current = {
      u: { "thread:t/conn_a": { "agent-sandbox": ENTRY_A } },
    };
    const next = mergeAgentSandboxMapEntry(
      current,
      "u",
      "thread:t/conn_b",
      ENTRY_B,
    );
    expect(entryAt(next, "u", "thread:t/conn_a", "agent-sandbox")).toEqual(
      ENTRY_A,
    );
    expect(entryAt(next, "u", "thread:t/conn_b", "agent-sandbox")).toEqual(
      CANONICAL_ENTRY_B,
    );
  });

  test("preserves sibling kinds on the same branch", () => {
    const current = { u: { b: { "user-desktop": ENTRY_A } } };
    const next = mergeAgentSandboxMapEntry(current, "u", "b", ENTRY_B);
    expect(entryAt(next, "u", "b", "user-desktop")).toEqual(ENTRY_A);
    expect(entryAt(next, "u", "b", "agent-sandbox")).toEqual(CANONICAL_ENTRY_B);
  });

  test("does not mutate the input map", () => {
    const current = { u: { b: { "agent-sandbox": ENTRY_A } } };
    const snapshot = JSON.stringify(current);
    mergeAgentSandboxMapEntry(current, "u", "b", ENTRY_B);
    expect(JSON.stringify(current)).toBe(snapshot);
  });

  test("normalizes a legacy stringified branch cell instead of corrupting it", () => {
    // parseBranchMap treats a non-object (stringified) cell as empty, so the
    // merge drops the unreadable cell rather than a raw spread exploding it into
    // character-indexed keys ("0","1",...).
    const current = {
      u: { b: JSON.stringify({ "agent-sandbox": ENTRY_A }) },
    } as unknown as Parameters<typeof mergeAgentSandboxMapEntry>[0];
    const next = mergeAgentSandboxMapEntry(current, "u", "b", ENTRY_B);
    expect(entryAt(next, "u", "b", "agent-sandbox")).toEqual(CANONICAL_ENTRY_B);
    expect(next.u?.b).not.toHaveProperty("0");
  });

  test("overwrites a conflicting embedded discriminator with the canonical kind", () => {
    const mislabeled: SandboxRecord = {
      ...ENTRY_B,
      sandboxProviderKind: "user-desktop",
    };

    const next = mergeAgentSandboxMapEntry({}, "u", "b", mislabeled);

    expect(entryAt(next, "u", "b", "agent-sandbox")).toEqual(CANONICAL_ENTRY_B);
  });
});

describe("deleteAgentSandboxMapEntry", () => {
  test("returns null when the entry is absent (no-op write)", () => {
    expect(deleteAgentSandboxMapEntry({}, "u", "b")).toBeNull();
    const other = { u: { b: { "user-desktop": ENTRY_A } } };
    expect(deleteAgentSandboxMapEntry(other, "u", "b")).toBeNull();
  });

  test("removes the entry and prunes empty branch + user buckets", () => {
    const current = { u: { b: { "agent-sandbox": ENTRY_A } } };
    const next = deleteAgentSandboxMapEntry(current, "u", "b");
    expect(next).toEqual({});
  });

  test("keeps sibling kinds and sibling branches", () => {
    const current = {
      u: {
        b: { "agent-sandbox": ENTRY_A, "user-desktop": ENTRY_B },
        other: { "agent-sandbox": ENTRY_A },
      },
    };
    const next = deleteAgentSandboxMapEntry(current, "u", "b");
    expect(entryAt(next!, "u", "b", "user-desktop")).toEqual(ENTRY_B);
    expect(entryAt(next!, "u", "other", "agent-sandbox")).toEqual(ENTRY_A);
    expect(entryAt(next!, "u", "b", "agent-sandbox")).toBeNull();
  });
});

describe("setAgentSandboxMapEntry", () => {
  // Setup: a fake storage adapter that captures the metadata blob written by
  // the writer so we can assert the new key carries the merged shape.
  test("writes the entry under sandboxMap[user][branch][kind]", async () => {
    const { setAgentSandboxMapEntry } = await import("./sandbox-map");
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
      sandboxProviderKind: "agent-sandbox",
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await setAgentSandboxMapEntry(
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

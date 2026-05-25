/**
 * Unit tests for sandboxMap helpers (pure functions).
 */

import { describe, expect, test } from "bun:test";
import type { SandboxRecord } from "@decocms/mesh-sdk";

import { readSandboxMap, resolveVm } from "./sandbox-map";

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
    const sandboxMap = { "user-1": { main: { "local-docker": ENTRY_A } } };
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
      sandboxProviderKind: "cluster",
    };
    const meta = { sandboxMap: { user1: { main: { cluster: inner } } } };
    expect(readSandboxMap(meta)).toEqual(meta.sandboxMap);
  });

  test("ignores the legacy `vmMap` key (migration 091 sweeps it away)", () => {
    const inner: SandboxRecord = {
      sandboxHandle: "h1",
      previewUrl: null,
      createdAt: 1,
      sandboxProviderKind: "cluster",
    };
    const meta = { vmMap: { user1: { main: { cluster: inner } } } };
    expect(readSandboxMap(meta)).toEqual({});
  });
});

describe("resolveVm", () => {
  test("returns null when user is absent", () => {
    expect(resolveVm({}, "user-1", "main", "local-docker")).toBeNull();
  });

  test("returns null when branch is absent for that user", () => {
    const sandboxMap = { "user-1": { main: { "local-docker": ENTRY_A } } };
    expect(
      resolveVm(sandboxMap, "user-1", "feat/x", "local-docker"),
    ).toBeNull();
  });

  test("returns the entry when userId, branch, and kind are all present", () => {
    const sandboxMap = {
      "user-1": {
        main: { "local-docker": ENTRY_A },
        "feat/x": { "local-docker": ENTRY_B },
      },
    };
    expect(resolveVm(sandboxMap, "user-1", "feat/x", "local-docker")).toEqual(
      ENTRY_B,
    );
  });

  test("isolates users from each other", () => {
    const sandboxMap = {
      "user-1": { main: { "local-docker": ENTRY_A } },
      "user-2": { main: { "local-docker": ENTRY_B } },
    };
    expect(resolveVm(sandboxMap, "user-1", "main", "local-docker")).toEqual(
      ENTRY_A,
    );
    expect(resolveVm(sandboxMap, "user-2", "main", "local-docker")).toEqual(
      ENTRY_B,
    );
  });

  test("returns null when the kind is absent but another kind exists", () => {
    const sandboxMap = {
      "user-1": { main: { "local-docker": ENTRY_A } },
    };
    // looking up "cluster" when only "local-docker" exists → null
    expect(resolveVm(sandboxMap, "user-1", "main", "cluster")).toBeNull();
  });

  test("returns the entry for the requested kind when multiple kinds coexist", () => {
    const sandboxMap = {
      "user-1": { main: { "local-docker": ENTRY_A, cluster: ENTRY_B } },
    };
    expect(resolveVm(sandboxMap, "user-1", "main", "local-docker")).toEqual(
      ENTRY_A,
    );
    expect(resolveVm(sandboxMap, "user-1", "main", "cluster")).toEqual(ENTRY_B);
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
      sandboxProviderKind: "cluster",
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await setSandboxMapEntry(
      storage as unknown as import("../../storage/ports").VirtualMCPStoragePort,
      "vmcp_1",
      "u",
      "u",
      "b",
      "cluster",
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
    expect(sm.u?.b?.cluster).toEqual(newEntry);
  });
});

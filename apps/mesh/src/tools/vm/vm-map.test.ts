/**
 * Unit tests for vmMap helpers (pure functions).
 */

import { describe, expect, test } from "bun:test";
import type { VmMapEntry } from "@decocms/mesh-sdk";

import { readVmMap, resolveVm } from "./vm-map";

const ENTRY_A: VmMapEntry = {
  vmId: "vm-1",
  previewUrl: "https://vm-1.deco.studio",
};
const ENTRY_B: VmMapEntry = {
  vmId: "vm-2",
  previewUrl: "https://vm-2.deco.studio",
};

describe("readVmMap", () => {
  test("returns empty object when metadata is null", () => {
    expect(readVmMap(null)).toEqual({});
  });

  test("returns empty object when metadata is undefined", () => {
    expect(readVmMap(undefined)).toEqual({});
  });

  test("returns empty object when vmMap key is missing", () => {
    expect(readVmMap({ githubRepo: null })).toEqual({});
  });

  test("returns the vmMap when present", () => {
    // 3-level: userId → branch → kind → entry
    const vmMap = { "user-1": { main: { docker: ENTRY_A } } };
    expect(readVmMap({ vmMap })).toEqual(vmMap);
  });

  test("returns empty when vmMap is not an object", () => {
    expect(readVmMap({ vmMap: "not an object" })).toEqual({});
  });
});

describe("resolveVm", () => {
  test("returns null when user is absent", () => {
    expect(resolveVm({}, "user-1", "main", "docker")).toBeNull();
  });

  test("returns null when branch is absent for that user", () => {
    const vmMap = { "user-1": { main: { docker: ENTRY_A } } };
    expect(resolveVm(vmMap, "user-1", "feat/x", "docker")).toBeNull();
  });

  test("returns the entry when userId, branch, and kind are all present", () => {
    const vmMap = {
      "user-1": {
        main: { docker: ENTRY_A },
        "feat/x": { docker: ENTRY_B },
      },
    };
    expect(resolveVm(vmMap, "user-1", "feat/x", "docker")).toEqual(ENTRY_B);
  });

  test("isolates users from each other", () => {
    const vmMap = {
      "user-1": { main: { docker: ENTRY_A } },
      "user-2": { main: { docker: ENTRY_B } },
    };
    expect(resolveVm(vmMap, "user-1", "main", "docker")).toEqual(ENTRY_A);
    expect(resolveVm(vmMap, "user-2", "main", "docker")).toEqual(ENTRY_B);
  });

  test("returns null when the kind is absent but another kind exists", () => {
    const vmMap = {
      "user-1": { main: { docker: ENTRY_A } },
    };
    // looking up "agent-sandbox" when only "docker" exists → null
    expect(resolveVm(vmMap, "user-1", "main", "agent-sandbox")).toBeNull();
  });

  test("returns the entry for the requested kind when multiple kinds coexist", () => {
    const vmMap = {
      "user-1": { main: { docker: ENTRY_A, "agent-sandbox": ENTRY_B } },
    };
    expect(resolveVm(vmMap, "user-1", "main", "docker")).toEqual(ENTRY_A);
    expect(resolveVm(vmMap, "user-1", "main", "agent-sandbox")).toEqual(
      ENTRY_B,
    );
  });
});

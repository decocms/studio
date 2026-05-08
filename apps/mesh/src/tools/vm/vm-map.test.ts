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
    const vmMap = { "user-1": { main: ENTRY_A } };
    expect(readVmMap({ vmMap })).toEqual(vmMap);
  });

  test("returns empty when vmMap is not an object", () => {
    expect(readVmMap({ vmMap: "not an object" })).toEqual({});
  });
});

describe("resolveVm", () => {
  test("returns null when user is absent", () => {
    expect(resolveVm({}, "user-1", "main")).toBeNull();
  });

  test("returns null when branch is absent for that user", () => {
    const vmMap = { "user-1": { main: ENTRY_A } };
    expect(resolveVm(vmMap, "user-1", "feat/x")).toBeNull();
  });

  test("returns the entry when both are present", () => {
    const vmMap = { "user-1": { main: ENTRY_A, "feat/x": ENTRY_B } };
    expect(resolveVm(vmMap, "user-1", "feat/x")).toEqual(ENTRY_B);
  });

  test("isolates users from each other", () => {
    const vmMap = {
      "user-1": { main: ENTRY_A },
      "user-2": { main: ENTRY_B },
    };
    expect(resolveVm(vmMap, "user-1", "main")).toEqual(ENTRY_A);
    expect(resolveVm(vmMap, "user-2", "main")).toEqual(ENTRY_B);
  });
});

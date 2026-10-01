import { describe, expect, test } from "bun:test";
import {
  normalizeProjectFolders,
  normalizeSidebarPreferences,
} from "./project-sidebar";

describe("normalizeProjectFolders", () => {
  test("a project listed in two folders stays in the first", () => {
    const folders = normalizeProjectFolders([
      { id: "a", name: "A", projectIds: ["p1", "p2"] },
      { id: "b", name: "B", projectIds: ["p2", "p3"] },
    ]);
    expect(folders.map((f) => f.projectIds)).toEqual([["p1", "p2"], ["p3"]]);
  });

  test("a repeated folder id keeps its first entry", () => {
    const folders = normalizeProjectFolders([
      { id: "a", name: "First", projectIds: [] },
      { id: "a", name: "Second", projectIds: ["p1"] },
    ]);
    expect(folders).toEqual([{ id: "a", name: "First", projectIds: [] }]);
  });

  test("an empty list stays empty", () => {
    expect(normalizeProjectFolders([])).toEqual([]);
  });
});

describe("normalizeSidebarPreferences", () => {
  test("a project is in one state, the last list it appears in", () => {
    const prefs = normalizeSidebarPreferences({
      pinned: ["p1", "p2"],
      hidden: ["p2"],
      dismissed: ["p1"],
      hiddenFolders: [],
    });
    expect(prefs).toEqual({
      pinned: [],
      hidden: ["p2"],
      dismissed: ["p1"],
      hiddenFolders: [],
    });
  });

  test("duplicates collapse and pin order is kept", () => {
    const prefs = normalizeSidebarPreferences({
      pinned: ["p3", "p1", "p3"],
      hidden: [],
      dismissed: [],
      hiddenFolders: ["f", "f"],
    });
    expect(prefs.pinned).toEqual(["p3", "p1"]);
    expect(prefs.hiddenFolders).toEqual(["f"]);
  });
});

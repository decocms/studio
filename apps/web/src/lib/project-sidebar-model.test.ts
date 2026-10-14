import { describe, expect, test } from "bun:test";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import {
  EMPTY_SIDEBAR_PREFERENCES,
  type ProjectFolder,
  type SidebarPreferences,
} from "@decocms/shared/project-sidebar";
import {
  buildProjectSidebar,
  deleteFolder,
  moveProject,
  setFolderHidden,
  setProjectState,
} from "./project-sidebar-model";

const project = (id: string, createdAt = "2025-01-01T00:00:00.000Z") =>
  ({ id, title: id, created_at: createdAt }) as VirtualMCPEntity;

const OLD = "2025-06-01T00:00:00.000Z";

function build({
  projects,
  folders = [],
  preferences = {},
}: {
  projects: VirtualMCPEntity[];
  folders?: ProjectFolder[];
  preferences?: Partial<SidebarPreferences>;
}) {
  return buildProjectSidebar({
    projects,
    folders,
    preferences: { ...EMPTY_SIDEBAR_PREFERENCES, ...preferences },
  });
}

const ids = (list: { id: string }[]) => list.map((p) => p.id);

describe("buildProjectSidebar", () => {
  test("with no folders or preferences, every project is loose", () => {
    const model = build({ projects: [project("a", OLD), project("b", OLD)] });
    expect(ids(model.loose)).toEqual(["a", "b"]);
    expect(model.pinned).toEqual([]);
  });

  test("folders hold their projects in folder order; the rest are loose", () => {
    const model = build({
      projects: [project("a", OLD), project("b", OLD), project("c", OLD)],
      folders: [{ id: "f", name: "F", projectIds: ["c", "a"] }],
    });
    expect(ids(model.folders[0]?.projects ?? [])).toEqual(["c", "a"]);
    expect(ids(model.loose)).toEqual(["b"]);
  });

  test("a pinned project shows only in Pinned, in pin order", () => {
    const model = build({
      projects: [project("a", OLD), project("b", OLD)],
      folders: [{ id: "f", name: "F", projectIds: ["a"] }],
      preferences: { pinned: ["b", "a"] },
    });
    expect(ids(model.pinned)).toEqual(["b", "a"]);
    expect(model.folders[0]?.projects).toEqual([]);
    expect(model.loose).toEqual([]);
  });

  test("pinning wins over hiding the project's folder", () => {
    const model = build({
      projects: [project("a", OLD), project("b", OLD)],
      folders: [{ id: "f", name: "F", projectIds: ["a", "b"] }],
      preferences: { pinned: ["a"], hiddenFolders: ["f"] },
    });
    expect(ids(model.pinned)).toEqual(["a"]);
    expect(model.folders).toEqual([]);
    expect(ids(model.hiddenFolders[0]?.projects ?? [])).toEqual(["b"]);
  });

  test("a hidden project leaves its folder for Hidden", () => {
    const model = build({
      projects: [project("a", OLD), project("b", OLD)],
      folders: [{ id: "f", name: "F", projectIds: ["a", "b"] }],
      preferences: { hidden: ["a"] },
    });
    expect(ids(model.folders[0]?.projects ?? [])).toEqual(["b"]);
    expect(ids(model.hidden)).toEqual(["a"]);
  });

  test("ids of deleted projects are ignored", () => {
    const model = build({
      projects: [project("a", OLD)],
      folders: [{ id: "f", name: "F", projectIds: ["gone", "a"] }],
      preferences: { pinned: ["gone"] },
    });
    expect(model.pinned).toEqual([]);
    expect(ids(model.folders[0]?.projects ?? [])).toEqual(["a"]);
  });
});

describe("edits", () => {
  test("a project moves between states, never in two", () => {
    let prefs = setProjectState(EMPTY_SIDEBAR_PREFERENCES, "a", "pinned");
    prefs = setProjectState(prefs, "a", "hidden");
    expect(prefs.pinned).toEqual([]);
    expect(prefs.hidden).toEqual(["a"]);
    expect(setProjectState(prefs, "a", null).hidden).toEqual([]);
  });

  test("hiding a folder twice keeps one entry", () => {
    const prefs = setFolderHidden(
      setFolderHidden(EMPTY_SIDEBAR_PREFERENCES, "f", true),
      "f",
      true,
    );
    expect(prefs.hiddenFolders).toEqual(["f"]);
    expect(setFolderHidden(prefs, "f", false).hiddenFolders).toEqual([]);
  });

  test("moving a project takes it out of its old folder", () => {
    const folders: ProjectFolder[] = [
      { id: "a", name: "A", projectIds: ["p"] },
      { id: "b", name: "B", projectIds: [] },
    ];
    const moved = moveProject(folders, "p", "b");
    expect(moved.map((f) => f.projectIds)).toEqual([[], ["p"]]);
    expect(moveProject(moved, "p", null).map((f) => f.projectIds)).toEqual([
      [],
      [],
    ]);
  });

  test("deleting a folder keeps nothing of it", () => {
    expect(
      deleteFolder([{ id: "a", name: "A", projectIds: ["p"] }], "a"),
    ).toEqual([]);
  });
});

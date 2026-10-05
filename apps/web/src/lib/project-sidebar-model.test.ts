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

const JOINED = "2026-01-01T00:00:00.000Z";
const OLD = "2025-06-01T00:00:00.000Z";
const NEW = "2026-03-01T00:00:00.000Z";

function build({
  projects,
  folders = [],
  preferences = {},
  waiting = {},
  joinedAt = JOINED,
}: {
  projects: VirtualMCPEntity[];
  folders?: ProjectFolder[];
  preferences?: Partial<SidebarPreferences>;
  waiting?: Record<string, number>;
  joinedAt?: string | null;
}) {
  return buildProjectSidebar({
    projects,
    folders,
    preferences: { ...EMPTY_SIDEBAR_PREFERENCES, ...preferences },
    joinedAt,
    waitingByProject: new Map(Object.entries(waiting)),
  });
}

const ids = (list: { id: string }[]) => list.map((p) => p.id);

describe("buildProjectSidebar", () => {
  test("with no folders or preferences, every project is loose", () => {
    const model = build({ projects: [project("a", OLD), project("b", OLD)] });
    expect(ids(model.loose)).toEqual(["a", "b"]);
    expect(model.pinned).toEqual([]);
    expect(model.suggested).toEqual([]);
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

  test("clearing Suggested covers new projects past the display cap", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      project(`n${i}`, `2026-03-0${i + 1}T00:00:00.000Z`),
    );
    const model = build({ projects: many });
    expect(model.suggested).toHaveLength(5);
    expect(model.clearableIds).toHaveLength(8);
  });

  test("a project created after the member joined is suggested until decided", () => {
    const fresh = build({
      projects: [project("old", OLD), project("new", NEW)],
    });
    expect(fresh.suggested.map((s) => [s.project.id, s.reason])).toEqual([
      ["new", "new"],
    ]);
    expect(ids(fresh.loose)).toEqual(["old"]);

    const dismissed = build({
      projects: [project("new", NEW)],
      preferences: { dismissed: ["new"] },
    });
    expect(dismissed.suggested).toEqual([]);
    expect(ids(dismissed.loose)).toEqual(["new"]);
  });

  test("hiding a new project and showing it again keeps it in its place", () => {
    let preferences = setProjectState(
      EMPTY_SIDEBAR_PREFERENCES,
      "new",
      "hidden",
    );
    preferences = setProjectState(preferences, "new", "dismissed");
    const model = build({ projects: [project("new", NEW)], preferences });
    expect(model.suggested).toEqual([]);
    expect(ids(model.loose)).toEqual(["new"]);
  });

  test("a new project in a hidden folder is not suggested", () => {
    const model = build({
      projects: [project("new", NEW)],
      folders: [{ id: "f", name: "F", projectIds: ["new"] }],
      preferences: { hiddenFolders: ["f"] },
    });
    expect(model.suggested).toEqual([]);
  });

  test("without a join date nothing is new", () => {
    expect(
      build({ projects: [project("new", NEW)], joinedAt: null }).suggested,
    ).toEqual([]);
  });

  test("a waiting task suggests a project and keeps it in its folder", () => {
    const model = build({
      projects: [project("a", OLD), project("b", OLD)],
      folders: [{ id: "f", name: "F", projectIds: ["a"] }],
      waiting: { a: 1, b: 3 },
    });
    expect(model.suggested.map((s) => [s.project.id, s.waiting])).toEqual([
      ["b", 3],
      ["a", 1],
    ]);
    expect(ids(model.folders[0]?.projects ?? [])).toEqual(["a"]);
    expect(ids(model.loose)).toEqual(["b"]);
  });

  test("hiding wins over a waiting task, for the project or its folder", () => {
    const model = build({
      projects: [project("a", OLD), project("b", OLD)],
      folders: [{ id: "f", name: "F", projectIds: ["b"] }],
      preferences: { hidden: ["a"], hiddenFolders: ["f"] },
      waiting: { a: 1, b: 1 },
    });
    expect(model.suggested).toEqual([]);
    expect(ids(model.hidden)).toEqual(["a"]);
  });

  test("a cleared waiting suggestion stays in its folder, still marked", () => {
    const model = build({
      projects: [project("a", OLD)],
      folders: [{ id: "f", name: "F", projectIds: ["a"] }],
      preferences: { dismissed: ["a"] },
      waiting: { a: 1 },
    });
    expect(model.suggested).toEqual([]);
    expect(ids(model.folders[0]?.projects ?? [])).toEqual(["a"]);
  });

  test("a pinned project with waiting tasks stays in Pinned", () => {
    const model = build({
      projects: [project("a", OLD)],
      preferences: { pinned: ["a"] },
      waiting: { a: 2 },
    });
    expect(ids(model.pinned)).toEqual(["a"]);
    expect(model.suggested).toEqual([]);
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

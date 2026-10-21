import { describe, expect, test } from "bun:test";
import {
  pushRecentProject,
  RECENT_PROJECTS_LIMIT,
} from "./use-recent-projects";

describe("pushRecentProject", () => {
  test("puts the opened project first", () => {
    expect(pushRecentProject(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  test("moves a project already there instead of repeating it", () => {
    expect(pushRecentProject(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  });

  test("keeps only the newest few", () => {
    const many = ["a", "b", "c", "d", "e"];
    expect(pushRecentProject(many, "f")).toHaveLength(RECENT_PROJECTS_LIMIT);
  });
});

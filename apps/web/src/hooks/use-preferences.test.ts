import { describe, expect, test } from "bun:test";
import {
  PROJECT_FIRST_NAV_DEFAULT_SINCE,
  projectFirstNavEnabled,
  readLaneVisibility,
} from "./use-preferences.ts";

describe("readLaneVisibility", () => {
  test("starts empty when nothing is stored", () => {
    expect(readLaneVisibility({})).toEqual({});
  });

  test("carries the retired shown-lanes list over as shown", () => {
    expect(readLaneVisibility({ shownTaskBoardLanes: ["archived"] })).toEqual({
      archived: true,
    });
  });

  test("a stored override wins over the retired list", () => {
    expect(
      readLaneVisibility({
        shownTaskBoardLanes: ["archived"],
        taskBoardLaneVisibility: { archived: false, qa: false },
      }),
    ).toEqual({ archived: false, qa: false });
  });

  test("drops entries that are not booleans or strings", () => {
    expect(
      readLaneVisibility({
        shownTaskBoardLanes: ["done", 3, null],
        taskBoardLaneVisibility: { qa: "no", todo: false },
      }),
    ).toEqual({ done: true, todo: false });
  });

  test("ignores a malformed stored value", () => {
    expect(readLaneVisibility({ taskBoardLaneVisibility: ["qa"] })).toEqual({});
    expect(readLaneVisibility({ shownTaskBoardLanes: "archived" })).toEqual({});
  });
});

describe("projectFirstNavEnabled", () => {
  const before = new Date(PROJECT_FIRST_NAV_DEFAULT_SINCE - 1);
  const after = new Date(PROJECT_FIRST_NAV_DEFAULT_SINCE + 1);

  test("new accounts start in project-first navigation", () => {
    expect(projectFirstNavEnabled(undefined, after)).toBe(true);
    expect(projectFirstNavEnabled(undefined, after.toISOString())).toBe(true);
  });

  test("older accounts keep the classic navigation", () => {
    expect(projectFirstNavEnabled(undefined, before)).toBe(false);
  });

  test("a stored choice wins over the account's age", () => {
    expect(projectFirstNavEnabled(false, after)).toBe(false);
    expect(projectFirstNavEnabled(true, before)).toBe(true);
  });

  test("an unknown or invalid creation date keeps the classic navigation", () => {
    expect(projectFirstNavEnabled(undefined, undefined)).toBe(false);
    expect(projectFirstNavEnabled(undefined, "not a date")).toBe(false);
  });
});

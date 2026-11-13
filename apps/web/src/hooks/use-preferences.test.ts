import { describe, expect, test } from "bun:test";
import { readLaneVisibility } from "./use-preferences.ts";

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

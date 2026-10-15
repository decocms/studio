import { describe, expect, it } from "bun:test";
import { parseDrill } from "./task-board-analytics";

describe("parseDrill", () => {
  it("reads cohorts, fields and the planned scope, joined by &", () => {
    expect(parseDrill("failed_qa")).toEqual([{ cohort: "failed_qa" }]);
    expect(parseDrill("planned&sprint:spr_1&shipped")).toEqual([
      { scope: "planned" },
      { field: "sprint", value: "spr_1" },
      { cohort: "shipped" },
    ]);
    expect(parseDrill("touch:Re-ran")).toEqual([
      { field: "touch", value: "Re-ran" },
    ]);
  });

  it("keeps everything after the first colon as the value", () => {
    expect(parseDrill("tag:a:b")).toEqual([{ field: "tag", value: "a:b" }]);
  });

  it("rejects an unknown part rather than widening to every card", () => {
    expect(parseDrill("")).toBeNull();
    expect(parseDrill("nope")).toBeNull();
    expect(parseDrill("shipped&colour:red")).toBeNull();
    expect(parseDrill("type:")).toBeNull();
    expect(parseDrill("shipped&")).toBeNull();
  });
});

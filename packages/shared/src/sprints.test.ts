import { describe, expect, it } from "bun:test";
import {
  compareSprints,
  currentSprintId,
  isCalendarDay,
  isFinishedStatus,
  nextSprintId,
  type Sprint,
  type SprintState,
} from "./sprints";

function sprint(
  id: string,
  state: SprintState,
  startDate: string | null = null,
): Sprint {
  return { id, name: id, state, startDate, endDate: null };
}

const sorted = (sprints: Sprint[]) =>
  [...sprints].sort(compareSprints).map((s) => s.id);

describe("compareSprints", () => {
  it("puts what is running first, then what is next, then history", () => {
    expect(
      sorted([
        sprint("closed-old", "closed", "2026-01-01"),
        sprint("future-far", "future", "2026-05-01"),
        sprint("active", "active", "2026-03-01"),
        sprint("future-near", "future", "2026-04-01"),
        sprint("closed-recent", "closed", "2026-02-01"),
      ]),
    ).toEqual([
      "active",
      "future-near",
      "future-far",
      "closed-recent",
      "closed-old",
    ]);
  });

  it("sorts unscheduled sprints last within their state", () => {
    expect(
      sorted([
        sprint("undated", "future"),
        sprint("dated", "future", "2026-04-01"),
      ]),
    ).toEqual(["dated", "undated"]);
  });

  it("breaks ties by name, then id", () => {
    expect(
      sorted([
        { ...sprint("b", "future"), name: "Same" },
        { ...sprint("a", "future"), name: "Same" },
        { ...sprint("c", "future"), name: "Earlier" },
      ]),
    ).toEqual(["c", "a", "b"]);
  });
});

describe("currentSprintId", () => {
  it("is the first running sprint in reading order", () => {
    expect(
      currentSprintId([
        sprint("later", "active", "2026-03-08"),
        sprint("earlier", "active", "2026-03-01"),
        sprint("next", "future", "2026-02-01"),
      ]),
    ).toBe("earlier");
  });

  it("is null when nothing is running", () => {
    expect(
      currentSprintId([sprint("f", "future"), sprint("c", "closed")]),
    ).toBeNull();
    expect(currentSprintId([])).toBeNull();
  });
});

describe("nextSprintId", () => {
  it("is the soonest planned sprint other than the one completing", () => {
    expect(
      nextSprintId(
        [
          sprint("now", "active", "2026-03-01"),
          sprint("far", "future", "2026-04-01"),
          sprint("near", "future", "2026-03-15"),
          sprint("old", "closed", "2026-02-01"),
        ],
        "now",
      ),
    ).toBe("near");
  });

  it("never picks another running or closed sprint", () => {
    expect(
      nextSprintId([sprint("now", "active"), sprint("other", "active")], "now"),
    ).toBeNull();
    expect(nextSprintId([sprint("old", "closed")], "now")).toBeNull();
  });
});

describe("isCalendarDay", () => {
  it("accepts a real day", () => {
    expect(isCalendarDay("2026-02-28")).toBe(true);
    expect(isCalendarDay("2028-02-29")).toBe(true);
  });

  it("rejects a day Date.parse would roll over", () => {
    expect(isCalendarDay("2026-02-31")).toBe(false);
    expect(isCalendarDay("2026-02-29")).toBe(false);
    expect(isCalendarDay("2026-13-01")).toBe(false);
  });

  it("rejects anything that is not exactly YYYY-MM-DD", () => {
    expect(isCalendarDay("2026-3-1")).toBe(false);
    expect(isCalendarDay("2026-03-01T00:00:00Z")).toBe(false);
    expect(isCalendarDay("")).toBe(false);
  });
});

describe("isFinishedStatus", () => {
  it("treats only done and archived as finished", () => {
    expect(isFinishedStatus("done")).toBe(true);
    expect(isFinishedStatus("archived")).toBe(true);
    for (const status of [
      "triage",
      "todo",
      "in_progress",
      "in_review",
      "approved",
      "merged",
      "post_deploy_validation",
    ]) {
      expect(isFinishedStatus(status)).toBe(false);
    }
  });
});

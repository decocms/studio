import { describe, expect, it } from "bun:test";
import {
  compareSprints,
  defaultSprint,
  isSprintState,
  type Sprint,
  type SprintState,
} from "./sprints";

function sprint(
  id: string,
  state: SprintState,
  startsAt: string | null = null,
): Sprint {
  return { id, name: id, state, startsAt, endsAt: null };
}

const sorted = (sprints: Sprint[]) =>
  [...sprints].sort(compareSprints).map((s) => s.id);

describe("compareSprints", () => {
  it("puts what is running first, then what is next, then history", () => {
    expect(
      sorted([
        sprint("closed-old", "closed", "2026-01-01T00:00:00.000Z"),
        sprint("future-far", "future", "2026-05-01T00:00:00.000Z"),
        sprint("active", "active", "2026-03-01T00:00:00.000Z"),
        sprint("future-near", "future", "2026-04-01T00:00:00.000Z"),
      ]),
    ).toEqual(["active", "future-near", "future-far", "closed-old"]);
  });

  it("orders history most-recent first, unlike upcoming sprints", () => {
    expect(
      sorted([
        sprint("jan", "closed", "2026-01-01T00:00:00.000Z"),
        sprint("mar", "closed", "2026-03-01T00:00:00.000Z"),
        sprint("feb", "closed", "2026-02-01T00:00:00.000Z"),
      ]),
    ).toEqual(["mar", "feb", "jan"]);
  });

  it("sorts a sprint with no dates last within its state, not first", () => {
    // null read as 0 would sort an unscheduled sprint before the epoch.
    expect(
      sorted([
        sprint("undated", "future"),
        sprint("dated", "future", "2026-04-01T00:00:00.000Z"),
      ]),
    ).toEqual(["dated", "undated"]);
  });

  it("treats an unparseable date as no date rather than as NaN", () => {
    expect(
      sorted([
        sprint("garbage", "future", "not a date"),
        sprint("dated", "future", "2026-04-01T00:00:00.000Z"),
      ]),
    ).toEqual(["dated", "garbage"]);
  });

  it("breaks ties by name then id, so the order is stable", () => {
    const a = {
      ...sprint("b", "future", "2026-04-01T00:00:00.000Z"),
      name: "A",
    };
    const b = {
      ...sprint("a", "future", "2026-04-01T00:00:00.000Z"),
      name: "B",
    };
    expect(sorted([b, a])).toEqual(["b", "a"]);
  });
});

describe("defaultSprint", () => {
  it("picks the running sprint over an earlier upcoming one", () => {
    const active = sprint("active", "active", "2026-03-01T00:00:00.000Z");
    expect(
      defaultSprint([
        sprint("future", "future", "2026-01-01T00:00:00.000Z"),
        active,
      ])?.id,
    ).toBe("active");
  });

  it("falls back to the soonest upcoming sprint when none is running", () => {
    expect(
      defaultSprint([
        sprint("later", "future", "2026-05-01T00:00:00.000Z"),
        sprint("sooner", "future", "2026-04-01T00:00:00.000Z"),
      ])?.id,
    ).toBe("sooner");
  });

  it("is null for a board with nothing but history", () => {
    expect(defaultSprint([sprint("done", "closed")])).toBe(null);
    expect(defaultSprint([])).toBe(null);
  });
});

describe("isSprintState", () => {
  it("accepts Jira's three states and nothing else", () => {
    for (const state of ["active", "future", "closed"]) {
      expect(isSprintState(state)).toBe(true);
    }
    for (const state of ["ACTIVE", "backlog", "", null, 1, undefined]) {
      expect(isSprintState(state)).toBe(false);
    }
  });
});

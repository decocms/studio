import { describe, expect, test } from "bun:test";
import type { Sprint } from "@decocms/shared/sprints";
import { localToday, suggestNextSprint } from "./sprint-draft";

function sprint(overrides: Partial<Sprint>): Sprint {
  return {
    id: "sprint_1",
    name: "Sprint 1",
    state: "future",
    startDate: null,
    endDate: null,
    ...overrides,
  };
}

describe("suggestNextSprint", () => {
  test("the first sprint starts today and runs two weeks", () => {
    expect(suggestNextSprint([], "2026-03-02")).toEqual({
      name: "Sprint 1",
      startDate: "2026-03-02",
      endDate: "2026-03-15",
    });
  });

  test("continues the numbering and starts after the latest sprint", () => {
    expect(
      suggestNextSprint(
        [
          sprint({ name: "Sprint 7", endDate: "2026-03-15" }),
          sprint({ name: "sprint 8", endDate: "2026-03-29" }),
        ],
        "2026-03-10",
      ),
    ).toEqual({
      name: "Sprint 9",
      startDate: "2026-03-30",
      endDate: "2026-04-12",
    });
  });

  test("never starts in the past", () => {
    expect(
      suggestNextSprint([sprint({ endDate: "2026-01-15" })], "2026-03-02")
        .startDate,
    ).toBe("2026-03-02");
  });

  test("counts sprints when none is numbered", () => {
    expect(
      suggestNextSprint(
        [sprint({ name: "Hardening" }), sprint({ name: "Launch" })],
        "2026-03-02",
      ).name,
    ).toBe("Sprint 3");
  });

  test("crosses a month and a year end", () => {
    expect(
      suggestNextSprint([sprint({ endDate: "2026-12-24" })], "2026-12-01"),
    ).toMatchObject({ startDate: "2026-12-25", endDate: "2027-01-07" });
  });
});

describe("localToday", () => {
  test("reads the local calendar day", () => {
    expect(localToday(new Date(2026, 2, 5, 23, 30))).toBe("2026-03-05");
  });
});

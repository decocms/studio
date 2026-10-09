import { describe, expect, test } from "bun:test";
import { formatSprintDays } from "./sprint-label";

describe("formatSprintDays", () => {
  test("spans both days, read as calendar days", () => {
    const label = formatSprintDays({
      startDate: "2026-03-02",
      endDate: "2026-03-15",
    });
    expect(label).toContain("2");
    expect(label).toContain("15");
    expect(label).toContain("–");
  });

  test("shows the one day that is set", () => {
    expect(
      formatSprintDays({ startDate: "2026-03-02", endDate: null }),
    ).toContain("2");
    expect(
      formatSprintDays({ startDate: null, endDate: "2026-03-15" }),
    ).toContain("15");
  });

  test("is null for a sprint with no dates", () => {
    expect(formatSprintDays({ startDate: null, endDate: null })).toBeNull();
  });
});

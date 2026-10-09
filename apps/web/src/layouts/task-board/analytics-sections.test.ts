import { describe, expect, it } from "bun:test";
import { fillDays, seriesKeys } from "./analytics-sections";

describe("seriesKeys", () => {
  it("drops the time field", () => {
    expect(seriesKeys([{ t: "2026-01-01", success: 1 }])).toEqual(["success"]);
  });

  it("stays stable regardless of which point introduces each key first", () => {
    const rangeA = [
      { t: "1", success: 1 },
      { t: "2", failure: 2 },
    ];
    const rangeB = [
      { t: "1", failure: 2 },
      { t: "2", success: 1 },
    ];
    expect(seriesKeys(rangeA)).toEqual(seriesKeys(rangeB));
  });
});

describe("fillDays", () => {
  const range = {
    from: "2026-10-01T15:00:00.000Z",
    to: "2026-10-04T09:00:00.000Z",
  };

  it("gives every day of the range a slot, zero where the server had none", () => {
    const filled = fillDays(
      [{ t: "2026-10-02T00:00:00.000Z", Errors: 3 }],
      ["Errors"],
      range,
    );
    expect(filled.map((p) => [String(p.t).slice(0, 10), p.Errors])).toEqual([
      ["2026-10-01", 0],
      ["2026-10-02", 3],
      ["2026-10-03", 0],
      ["2026-10-04", 0],
    ]);
  });

  it("keeps an empty range empty-valued rather than inventing data", () => {
    const filled = fillDays([], ["USD"], range);
    expect(filled).toHaveLength(4);
    expect(filled.every((p) => p.USD === 0)).toBe(true);
  });
});

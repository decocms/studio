import { describe, expect, it } from "bun:test";
import { seriesKeys } from "./analytics-sections";

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

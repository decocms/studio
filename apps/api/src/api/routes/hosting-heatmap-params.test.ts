import { describe, expect, it } from "bun:test";
import { heatmapParams } from "./hosting";

describe("heatmapParams", () => {
  it("keeps the read surface defaults when nothing is asked", () => {
    expect(heatmapParams(undefined, undefined)).toEqual({});
  });

  it("forwards a valid page and device", () => {
    expect(heatmapParams("/:product/p", "desktop")).toEqual({
      page: "/:product/p",
      device: "desktop",
    });
  });

  it("refuses a page that is not a path or is oversized", () => {
    expect(heatmapParams("https://other.example/", undefined)).toBeNull();
    expect(heatmapParams("", undefined)).toBeNull();
    expect(heatmapParams(`/${"a".repeat(512)}`, undefined)).toBeNull();
  });

  it("refuses an unknown device", () => {
    expect(heatmapParams("/", "watch")).toBeNull();
  });
});

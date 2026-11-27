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

  it("forwards a custom window only as two days", () => {
    expect(heatmapParams("/", "mobile", "2026-10-01", "2026-10-07")).toEqual({
      page: "/",
      device: "mobile",
      from: "2026-10-01",
      to: "2026-10-07",
    });
    expect(heatmapParams("/", "mobile", "2026-10-01", undefined)).toBeNull();
    expect(heatmapParams("/", "mobile", undefined, "2026-10-07")).toBeNull();
    expect(
      heatmapParams("/", "mobile", "2026-10-01T00:00:00Z", "2026-10-07"),
    ).toBeNull();
  });
});

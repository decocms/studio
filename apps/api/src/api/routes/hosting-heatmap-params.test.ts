import { describe, expect, it } from "bun:test";
import { analyticsQueryParams, heatmapParams } from "./hosting";

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

describe("analyticsQueryParams", () => {
  it("forwards nothing when nothing is asked", () => {
    expect(analyticsQueryParams({ f: [] })).toEqual({ f: [], single: {} });
  });

  it("forwards a segment, goal, currency and prop", () => {
    expect(
      analyticsQueryParams({
        f: ["path:starts:/produtos", "exp:is:hero=video:b"],
        goal: "lead_form",
        currency: "BRL",
        prop: "plan",
      }),
    ).toEqual({
      f: ["path:starts:/produtos", "exp:is:hero=video:b"],
      single: { goal: "lead_form", currency: "BRL", prop: "plan" },
    });
  });

  it("refuses an unknown dimension or operator, or an empty value", () => {
    expect(analyticsQueryParams({ f: ["cookie:is:x"] })).toBeNull();
    expect(analyticsQueryParams({ f: ["path:like:/x"] })).toBeNull();
    expect(analyticsQueryParams({ f: ["path:is:"] })).toBeNull();
    expect(analyticsQueryParams({ f: ["path"] })).toBeNull();
  });

  it("refuses too many or oversized filters", () => {
    expect(
      analyticsQueryParams({ f: Array.from({ length: 11 }, () => "os:is:x") }),
    ).toBeNull();
    expect(
      analyticsQueryParams({ f: [`path:is:/${"a".repeat(200)}`] }),
    ).toBeNull();
  });

  it("refuses a malformed goal, currency or prop", () => {
    expect(analyticsQueryParams({ f: [], goal: "a b" })).toBeNull();
    expect(analyticsQueryParams({ f: [], currency: "brl" })).toBeNull();
    expect(analyticsQueryParams({ f: [], prop: "" })).toBeNull();
  });
});

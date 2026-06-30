import { describe, expect, it } from "bun:test";
import {
  buildBlockColorMap,
  colorFromMap,
  extractScheduledVariants,
} from "./extract-variants";

describe("extractScheduledVariants", () => {
  it("emits one entry per date matcher and sorts by start", () => {
    const decofile = {
      Alerta: {
        __resolveType: "website/flags/multivariate/section.ts",
        variants: [
          {
            rule: {
              __resolveType: "website/matchers/multi.ts",
              op: "and",
              matchers: [
                { __resolveType: "ETC Segment" },
                {
                  __resolveType: "website/matchers/date.ts",
                  start: "2026-06-15T13:01:00.000Z",
                  end: "2026-07-01T02:59:00.000Z",
                },
              ],
            },
            value: {
              __resolveType: "site/sections/Content/Alert.tsx",
              config: { typeAlert: { message: "30% OFF" } },
            },
          },
          {
            rule: {
              __resolveType: "website/matchers/date.ts",
              start: "2026-06-01T00:00:00.000Z",
              end: "2026-06-08T00:00:00.000Z",
            },
            value: {
              __resolveType: "site/sections/Content/Alert.tsx",
              title: "Early bird",
            },
          },
        ],
      },
      // No multivariate flag resolver — should be ignored even if it has a `variants` field
      Other: {
        __resolveType: "site/sections/Other.tsx",
        variants: [{ rule: {} }],
      },
    };
    const out = extractScheduledVariants(decofile);
    expect(out).toHaveLength(2);
    expect(out[0]?.label).toBe("Early bird");
    expect(out[0]?.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(out[0]?.innerPath).toBe("");
    expect(out[1]?.label).toBe("30% OFF");
    expect(out[1]?.blockKey).toBe("Alerta");
  });

  it("finds nested multivariate flags inside arrays/objects", () => {
    const decofile = {
      "Category Banner - 01": {
        __resolveType: "site/sections/Images/BannerCollection.tsx",
        banners: [
          {
            image: {
              mobile: {
                __resolveType: "website/flags/multivariate/image.ts",
                variants: [
                  {
                    rule: {
                      __resolveType: "website/matchers/date.ts",
                      start: "2026-06-24T13:00:00.000Z",
                      end: "2026-07-08T02:59:00.000Z",
                    },
                    value:
                      "https://cdn.example.com/site/2026/06_JUNHO/banner-mobile.jpg",
                  },
                ],
              },
            },
          },
        ],
      },
    };
    const out = extractScheduledVariants(decofile);
    expect(out).toHaveLength(1);
    expect(out[0]?.blockKey).toBe("Category Banner - 01");
    expect(out[0]?.innerPath).toBe("banners[0] · image · mobile");
    expect(out[0]?.flagResolveType).toBe("website/flags/multivariate/image.ts");
    // URL value → last path segment as label
    expect(out[0]?.label).toBe("banner-mobile.jpg");
  });

  it("supports custom *-scoped multivariate flag resolveTypes", () => {
    const decofile = {
      ETCMediaKits: {
        __resolveType: "site/sections/MediaKits.tsx",
        mediaKits: [
          {
            content: {
              __resolveType: "site/flags/multivariate/etcMediaKitContent.ts",
              variants: [
                {
                  value: {
                    matcher: ["/farm-etc/novidades"],
                    desktop: { media: { alt: "mídia kit novidades" } },
                  },
                  rule: {
                    __resolveType: "website/matchers/date.ts",
                    start: "2026-06-25T17:05:00.000Z",
                    end: "2026-07-02T13:00:00.000Z",
                  },
                },
              ],
            },
          },
        ],
      },
    };
    const out = extractScheduledVariants(decofile);
    expect(out).toHaveLength(1);
    expect(out[0]?.blockKey).toBe("ETCMediaKits");
    expect(out[0]?.label).toBe("mídia kit novidades");
  });

  it("returns empty when decofile is null", () => {
    expect(extractScheduledVariants(null)).toEqual([]);
  });

  it("skips variants whose date range is missing or inverted", () => {
    const decofile = {
      A: {
        __resolveType: "website/flags/multivariate/section.ts",
        variants: [
          { rule: { __resolveType: "website/matchers/always.ts" }, value: {} },
          {
            rule: {
              __resolveType: "website/matchers/date.ts",
              start: "2026-06-10T00:00:00.000Z",
              end: "2026-06-01T00:00:00.000Z",
            },
            value: {},
          },
        ],
      },
    };
    expect(extractScheduledVariants(decofile)).toEqual([]);
  });
});

describe("buildBlockColorMap", () => {
  it("assigns the same color to the same key", () => {
    const map = buildBlockColorMap(["Alerta", "Other"]);
    expect(colorFromMap(map, "Alerta")).toEqual(colorFromMap(map, "Alerta"));
  });
  it("gives every distinct key a distinct color", () => {
    const keys = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    const map = buildBlockColorMap(keys);
    const bgs = keys.map((k) => colorFromMap(map, k).bg);
    expect(new Set(bgs).size).toBe(keys.length);
  });
  it("is stable across input ordering", () => {
    const a = buildBlockColorMap(["A", "B", "C"]);
    const b = buildBlockColorMap(["C", "A", "B"]);
    expect(colorFromMap(a, "A")).toEqual(colorFromMap(b, "A"));
    expect(colorFromMap(a, "B")).toEqual(colorFromMap(b, "B"));
  });
  it("falls back when the key is unknown", () => {
    const map = buildBlockColorMap(["A"]);
    expect(colorFromMap(map, "missing").bg).toBeDefined();
  });
});

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

  it("extracts page-level `website/flags/multivariate.ts` variants", () => {
    // Mirrors a real decofile: the page's `sections` field is a page-level
    // multivariate flag (no `/section.ts` subpath), and each variant's
    // `value` is an array of section blocks rather than a single object.
    const decofile = {
      "pages-Home-000001": {
        name: "Home",
        path: "/",
        __resolveType: "website/pages/Page.tsx",
        sections: {
          __resolveType: "website/flags/multivariate.ts",
          variants: [
            {
              rule: {
                __resolveType: "website/matchers/date.ts",
                start: "2026-06-30T23:00:00.000Z",
                end: "2026-07-03T13:00:00.000Z",
              },
              value: [
                { __resolveType: "Header" },
                { __resolveType: "site/sections/Landing/Hero.tsx" },
                { __resolveType: "Footer" },
              ],
            },
            {
              rule: {
                __resolveType: "website/matchers/location.ts",
                includeLocations: [],
              },
              value: [{ __resolveType: "Header" }],
            },
          ],
        },
      },
    };
    const out = extractScheduledVariants(decofile);
    // Only the date-gated variant lands on the calendar.
    expect(out).toHaveLength(1);
    expect(out[0]?.blockKey).toBe("pages-Home-000001");
    expect(out[0]?.blockLabel).toBe("Home");
    expect(out[0]?.flagResolveType).toBe("website/flags/multivariate.ts");
    // Page-level flags carry no inner path, so the label is the page name
    // rather than the raw "sections" field.
    expect(out[0]?.innerPath).toBe("");
    expect(out[0]?.label).toBe("Home");
    expect(out[0]?.start.toISOString()).toBe("2026-06-30T23:00:00.000Z");
    expect(out[0]?.end.toISOString()).toBe("2026-07-03T13:00:00.000Z");
  });

  it("includes open-ended variants (start-only) and flags them", () => {
    const decofile = {
      Promo: {
        __resolveType: "website/flags/multivariate/section.ts",
        variants: [
          {
            rule: {
              __resolveType: "website/matchers/date.ts",
              start: "2026-06-01T00:00:00.000Z",
              // no `end` → runs indefinitely
            },
            value: { title: "Launch (ongoing)" },
          },
        ],
      },
    };
    const out = extractScheduledVariants(decofile);
    expect(out).toHaveLength(1);
    expect(out[0]?.label).toBe("Launch (ongoing)");
    expect(out[0]?.openStart).toBe(false);
    expect(out[0]?.openEnd).toBe(true);
    expect(out[0]?.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("includes open-ended variants (end-only) and flags them", () => {
    const decofile = {
      Sunset: {
        __resolveType: "website/flags/multivariate/section.ts",
        variants: [
          {
            rule: {
              __resolveType: "website/matchers/date.ts",
              // no `start` → runs since forever
              end: "2026-07-01T00:00:00.000Z",
            },
            value: { title: "Until launch" },
          },
        ],
      },
    };
    const out = extractScheduledVariants(decofile);
    expect(out).toHaveLength(1);
    expect(out[0]?.openStart).toBe(true);
    expect(out[0]?.openEnd).toBe(false);
    expect(out[0]?.end.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("excludes an always-on date matcher with neither start nor end", () => {
    const decofile = {
      AlwaysOn: {
        __resolveType: "website/flags/multivariate/section.ts",
        variants: [
          {
            rule: { __resolveType: "website/matchers/date.ts" },
            value: { title: "no bounds" },
          },
        ],
      },
    };
    expect(extractScheduledVariants(decofile)).toEqual([]);
  });

  it("does not treat `multivariateFoo.ts` as a variant container", () => {
    // Regression guard for the widened regex: only `multivariate.ts` or
    // `multivariate/<kind>.ts` count — not an arbitrary `multivariate*.ts`.
    const decofile = {
      NotAFlag: {
        __resolveType: "website/flags/multivariateFoo.ts",
        variants: [
          {
            rule: {
              __resolveType: "website/matchers/date.ts",
              start: "2026-06-01T00:00:00.000Z",
              end: "2026-06-10T00:00:00.000Z",
            },
            value: { title: "should not appear" },
          },
        ],
      },
    };
    expect(extractScheduledVariants(decofile)).toEqual([]);
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

  it("supports legacy $live matcher aliases", () => {
    const decofile = {
      Legacy: {
        __resolveType: "$live/flags/multivariate/section.ts",
        variants: [
          {
            rule: {
              __resolveType: "$live/matchers/MatchMulti.ts",
              op: "and",
              matchers: [
                {
                  __resolveType: "$live/matchers/MatchDate.ts",
                  start: "2026-06-01T00:00:00.000Z",
                  end: "2026-06-10T00:00:00.000Z",
                },
              ],
            },
            value: { __resolveType: "site/sections/Foo.tsx", title: "legacy" },
          },
        ],
      },
    };
    const out = extractScheduledVariants(decofile);
    expect(out).toHaveLength(1);
    expect(out[0]?.blockKey).toBe("Legacy");
    expect(out[0]?.label).toBe("legacy");
  });

  it("emits one entry per date matcher inside a multi.ts rule", () => {
    const decofile = {
      DualWindow: {
        __resolveType: "website/flags/multivariate/section.ts",
        variants: [
          {
            rule: {
              __resolveType: "website/matchers/multi.ts",
              op: "or",
              matchers: [
                {
                  __resolveType: "website/matchers/date.ts",
                  start: "2026-06-01T00:00:00.000Z",
                  end: "2026-06-05T00:00:00.000Z",
                },
                {
                  __resolveType: "website/matchers/date.ts",
                  start: "2026-07-01T00:00:00.000Z",
                  end: "2026-07-05T00:00:00.000Z",
                },
              ],
            },
            value: { title: "Two windows" },
          },
        ],
      },
    };
    const out = extractScheduledVariants(decofile);
    expect(out).toHaveLength(2);
    expect(out[0]?.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(out[1]?.start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(out.every((v) => v.label === "Two windows")).toBe(true);
  });

  it("walks into variant.value to find nested multivariate flags", () => {
    const decofile = {
      Outer: {
        __resolveType: "website/flags/multivariate/section.ts",
        variants: [
          {
            rule: {
              __resolveType: "website/matchers/date.ts",
              start: "2026-06-01T00:00:00.000Z",
              end: "2026-06-10T00:00:00.000Z",
            },
            value: {
              __resolveType: "site/sections/Banner.tsx",
              image: {
                __resolveType: "website/flags/multivariate/image.ts",
                variants: [
                  {
                    rule: {
                      __resolveType: "website/matchers/date.ts",
                      start: "2026-06-15T00:00:00.000Z",
                      end: "2026-06-20T00:00:00.000Z",
                    },
                    value: "https://example.com/inner.jpg",
                  },
                ],
              },
            },
          },
        ],
      },
    };
    const out = extractScheduledVariants(decofile);
    expect(out).toHaveLength(2);
    const inner = out.find((v) =>
      v.flagResolveType.includes("multivariate/image"),
    );
    expect(inner).toBeDefined();
    expect(inner?.label).toBe("inner.jpg");
    expect(inner?.innerPath).toContain("variants[0] · value · image");
  });

  it("humanizes pages-* block keys for display", () => {
    const decofile = {
      "pages-Bazar%20Melhores%20Descontos-743529": {
        __resolveType: "website/flags/multivariate/section.ts",
        variants: [
          {
            rule: {
              __resolveType: "website/matchers/date.ts",
              start: "2026-06-01T00:00:00.000Z",
              end: "2026-06-10T00:00:00.000Z",
            },
            value: {},
          },
        ],
      },
    };
    const out = extractScheduledVariants(decofile);
    expect(out).toHaveLength(1);
    expect(out[0]?.blockLabel).toBe("Bazar Melhores Descontos");
    // blockKey itself stays raw for stable color/grouping.
    expect(out[0]?.blockKey).toBe("pages-Bazar%20Melhores%20Descontos-743529");
  });

  it("falls back to the section's resolveType when no value label is available", () => {
    const decofile = {
      Section: {
        __resolveType: "website/flags/multivariate/section.ts",
        variants: [
          {
            rule: {
              __resolveType: "website/matchers/date.ts",
              start: "2026-06-01T00:00:00.000Z",
              end: "2026-06-10T00:00:00.000Z",
            },
            value: {
              __resolveType: "site/sections/NewSearch/ProductListGallery.tsx",
            },
          },
        ],
      },
    };
    const out = extractScheduledVariants(decofile);
    expect(out[0]?.label).toBe("ProductListGallery");
  });

  it("truncates very long plain-string values to 80 chars", () => {
    const longString = "x".repeat(200);
    const decofile = {
      Block: {
        __resolveType: "website/flags/multivariate/image.ts",
        variants: [
          {
            rule: {
              __resolveType: "website/matchers/date.ts",
              start: "2026-06-01T00:00:00.000Z",
              end: "2026-06-10T00:00:00.000Z",
            },
            value: longString,
          },
        ],
      },
    };
    const out = extractScheduledVariants(decofile);
    expect(out[0]?.label.length).toBeLessThanOrEqual(80);
    expect(out[0]?.label.endsWith("…")).toBe(true);
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

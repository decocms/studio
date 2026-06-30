import { describe, expect, it } from "bun:test";
import { colorForBlock, extractScheduledVariants } from "./extract-variants";

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
      // No variants resolver — should be ignored even if it has a `variants` field
      Other: {
        __resolveType: "site/sections/Other.tsx",
        variants: [{ rule: {} }],
      },
    };
    const out = extractScheduledVariants(decofile);
    expect(out).toHaveLength(2);
    expect(out[0]?.label).toBe("Early bird");
    expect(out[0]?.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(out[1]?.label).toBe("30% OFF");
    expect(out[1]?.blockKey).toBe("Alerta");
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

describe("colorForBlock", () => {
  it("is stable for the same key", () => {
    expect(colorForBlock("Alerta")).toEqual(colorForBlock("Alerta"));
  });
  it("differs across keys", () => {
    expect(colorForBlock("Alerta").bg).not.toBe(
      colorForBlock("Category Banner - 01").bg,
    );
  });
});

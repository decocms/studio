import { describe, expect, it } from "bun:test";
import {
  buildPageVariantOverrideParams,
  buildSectionVariantOverrideParams,
  MATCHER_OVERRIDE_QS,
  type PageVariantInfo,
  withVariantMatcherOverride,
} from "./variant-matcher-override";

const ALWAYS = { __resolveType: "website/matchers/always.ts" };
const inline = (rt: string) => ({ __resolveType: rt });

function mv(...rules: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    __resolveType: "website/flags/multivariate/section.ts",
    variants: rules.map((rule) => ({
      value: { __resolveType: "site/sections/Hero.tsx" },
      rule,
    })),
  };
}

const SINGLE_PAGE: PageVariantInfo = {
  multivariate: false,
  index: 0,
  variants: [{ rule: ALWAYS }],
};

describe("buildSectionVariantOverrideParams", () => {
  it("forces the selected variant on and earlier variants off", () => {
    const params = buildSectionVariantOverrideParams({
      pageKey: "pages-Home-1",
      page: SINGLE_PAGE,
      sectionIndex: 2,
      sectionLazy: false,
      mvObj: mv(ALWAYS, inline("website/matchers/device.ts"), ALWAYS),
      selectedVariantIndex: 1,
      decofile: {},
      meta: null,
    });

    expect(params).toEqual([
      "pages-Home-1@sections.2.variants.0.rule=0",
      "pages-Home-1@sections.2.variants.1.rule=1",
    ]);
  });

  it("inserts `.section` for lazy-wrapped sections", () => {
    const params = buildSectionVariantOverrideParams({
      pageKey: "pages-home-c4bcbfb771e9",
      page: SINGLE_PAGE,
      sectionIndex: 9,
      sectionLazy: true,
      mvObj: mv(ALWAYS, ALWAYS),
      selectedVariantIndex: 0,
      decofile: {},
      meta: null,
    });

    expect(params).toEqual([
      "pages-home-c4bcbfb771e9@sections.9.section.variants.0.rule=1",
    ]);
  });

  it("nests under the active page variant for multivariate pages", () => {
    const params = buildSectionVariantOverrideParams({
      pageKey: "pages-Home-1",
      page: { multivariate: true, index: 2, variants: [{}, {}, {}] },
      sectionIndex: 4,
      sectionLazy: false,
      mvObj: mv(ALWAYS, ALWAYS),
      selectedVariantIndex: 1,
      decofile: {},
      meta: null,
    });

    expect(params).toEqual([
      "pages-Home-1@sections.variants.2.value.4.variants.0.rule=0",
      "pages-Home-1@sections.variants.2.value.4.variants.1.rule=1",
    ]);
  });

  it("uses the block resolveType as id for saved matcher block references", () => {
    const savedKey = "matchers-Black-Friday-abc";
    const decofile = {
      [savedKey]: { __resolveType: "website/matchers/date.ts", name: "BF" },
    };
    const params = buildSectionVariantOverrideParams({
      pageKey: "pages-Home-1",
      page: SINGLE_PAGE,
      sectionIndex: 1,
      sectionLazy: false,
      mvObj: mv(ALWAYS, inline(savedKey)),
      selectedVariantIndex: 1,
      decofile,
      meta: null,
    });

    expect(params).toEqual([
      "pages-Home-1@sections.1.variants.0.rule=0",
      `${savedKey}=1`,
    ]);
  });
});

describe("buildPageVariantOverrideParams", () => {
  it("returns [] for a non-multivariate page", () => {
    expect(
      buildPageVariantOverrideParams("pages-Home-1", SINGLE_PAGE, {}, null),
    ).toEqual([]);
  });

  it("forces the active page variant", () => {
    const params = buildPageVariantOverrideParams(
      "pages-Home-1",
      { multivariate: true, index: 1, variants: [{ rule: ALWAYS }, {}, {}] },
      {},
      null,
    );
    expect(params).toEqual([
      "pages-Home-1@sections.variants.0.rule=0",
      "pages-Home-1@sections.variants.1.rule=1",
    ]);
  });
});

describe("withVariantMatcherOverride", () => {
  it("appends each param as a repeated query key", () => {
    const href = withVariantMatcherOverride(
      "https://site.example.com/?deviceHint=desktop",
      ["a@sections.0.variants.0.rule=0", "a@sections.0.variants.1.rule=1"],
    );
    const url = new URL(href);
    expect(url.searchParams.getAll(MATCHER_OVERRIDE_QS)).toEqual([
      "a@sections.0.variants.0.rule=0",
      "a@sections.0.variants.1.rule=1",
    ]);
    expect(url.searchParams.get("deviceHint")).toBe("desktop");
  });

  it("returns the href unchanged when there are no params", () => {
    const href = "https://site.example.com/?deviceHint=desktop";
    expect(withVariantMatcherOverride(href, [])).toBe(href);
  });

  it("replaces any pre-existing override params", () => {
    const href = withVariantMatcherOverride(
      `https://site.example.com/?${MATCHER_OVERRIDE_QS}=stale=1`,
      ["fresh=1"],
    );
    const url = new URL(href);
    expect(url.searchParams.getAll(MATCHER_OVERRIDE_QS)).toEqual(["fresh=1"]);
  });

  it("falls back to the unmodified href on a malformed URL instead of throwing", () => {
    const href = "http://[::1";
    expect(
      withVariantMatcherOverride(href, ["a@sections.0.variants.0.rule=0"]),
    ).toBe(href);
  });
});

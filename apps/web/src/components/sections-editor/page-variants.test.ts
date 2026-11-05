import { describe, expect, it } from "bun:test";
import {
  appendPageVariantSections,
  duplicatePageVariantEntry,
  buildPageSectionsFromVariants,
  getPageVariantCount,
  getPageVariantSectionsAt,
  isMultivariateArrayWrapper,
  isSectionMultivariateWrapperValue,
  parsePageVariants,
  unwrapMultivariateArrayValue,
  variantHasRule,
  wrapMultivariateArrayValue,
} from "./page-variants";
import {
  PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
  SECTION_MULTIVARIATE_RESOLVE_TYPE,
} from "./section-types";

describe("isSectionMultivariateWrapperValue", () => {
  it("matches a section-level multivariate flag wrapper", () => {
    expect(
      isSectionMultivariateWrapperValue(
        {
          __resolveType: SECTION_MULTIVARIATE_RESOLVE_TYPE,
          variants: [
            { value: { __resolveType: "site/sections/Header.tsx" }, rule: {} },
            { value: { __resolveType: "site/sections/Header.tsx" }, rule: {} },
          ],
        },
        false,
      ),
    ).toBe(true);
  });

  it("rejects the page-level multivariate flag wrapper", () => {
    expect(
      isSectionMultivariateWrapperValue(
        {
          __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
          variants: [{ value: [], rule: {} }],
        },
        false,
      ),
    ).toBe(false);
  });

  it("rejects plain arrays, primitives, and non-wrapper objects", () => {
    expect(isSectionMultivariateWrapperValue([], false)).toBe(false);
    expect(isSectionMultivariateWrapperValue(null, false)).toBe(false);
    expect(isSectionMultivariateWrapperValue("x", false)).toBe(false);
    expect(
      isSectionMultivariateWrapperValue(
        {
          __resolveType: SECTION_MULTIVARIATE_RESOLVE_TYPE,
        },
        false,
      ),
    ).toBe(false);
    expect(
      isSectionMultivariateWrapperValue(
        {
          __resolveType: "site/sections/Header.tsx",
          variants: [],
        },
        false,
      ),
    ).toBe(false);
  });
});

describe("v7: a short `multivariate` is a saved block's key", () => {
  const sectionWrapper = {
    __resolveType: "multivariate",
    variants: [{ value: { __resolveType: "Hero" }, rule: {} }],
  };
  const pageWrapper = {
    __resolveType: "multivariate",
    variants: [{ value: [{ __resolveType: "Hero" }], rule: {} }],
  };

  it("is no variants wrapper on v7, as on main", () => {
    expect(isSectionMultivariateWrapperValue(sectionWrapper, false)).toBe(
      false,
    );
    expect(isMultivariateArrayWrapper(pageWrapper, false)).toBe(false);
    expect(unwrapMultivariateArrayValue(pageWrapper, false)).toBeNull();
  });

  it("is the variants block on v8", () => {
    expect(isSectionMultivariateWrapperValue(sectionWrapper, true)).toBe(true);
    expect(isMultivariateArrayWrapper(pageWrapper, true)).toBe(true);
    expect(unwrapMultivariateArrayValue(pageWrapper, true)).toEqual([
      { __resolveType: "Hero" },
    ]);
  });
});

describe("page-variants", () => {
  it("unwraps multivariate global section arrays", () => {
    const sections = [
      { __resolveType: "Analytics" },
      { __resolveType: "Minicart" },
    ];
    expect(unwrapMultivariateArrayValue(sections, false)).toBeNull();
    expect(
      unwrapMultivariateArrayValue(
        {
          __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
          variants: [{ value: sections }],
        },
        false,
      ),
    ).toEqual(sections);
    expect(
      unwrapMultivariateArrayValue(
        {
          __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
          variants: "not-an-array",
        },
        false,
      ),
    ).toBeNull();
  });

  it("parses flat and multivariate page sections", () => {
    const flat = [{ __resolveType: "Hero" }];
    expect(parsePageVariants(flat, {}, () => "Rule")).toEqual([
      { label: "Default", sections: flat },
    ]);

    const decofile = {
      home: {
        __resolveType: "website/pages/Page.tsx",
        path: "/",
        sections: {
          variants: [
            {
              rule: { __resolveType: "website/matchers/always.ts" },
              value: [{ __resolveType: "A" }],
            },
          ],
        },
      },
    };
    const variants = parsePageVariants(
      decofile.home.sections,
      decofile,
      () => "Always",
    );
    expect(variants).toHaveLength(1);
    expect(variants[0]?.sections).toEqual([{ __resolveType: "A" }]);
    expect(getPageVariantSectionsAt(decofile, "home", 0)).toEqual([
      { __resolveType: "A" },
    ]);
  });

  it("wraps multivariate global section arrays on save", () => {
    const original = {
      __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
      variants: [
        {
          rule: { __resolveType: "website/matchers/always.ts" },
          value: [{ __resolveType: "Analytics" }],
        },
      ],
    };
    const next = [
      { __resolveType: "Analytics" },
      { __resolveType: "Minicart" },
    ];
    expect(
      wrapMultivariateArrayValue(original, next, undefined, false),
    ).toEqual({
      ...original,
      variants: [{ ...original.variants[0], value: next }],
    });
  });

  it("counts variants on flat and multivariate pages", () => {
    const decofile = {
      home: {
        __resolveType: "website/pages/Page.tsx",
        path: "/",
        sections: [{ __resolveType: "site/sections/Hero.tsx" }],
      },
      promo: {
        __resolveType: "website/pages/Page.tsx",
        path: "/promo",
        sections: {
          variants: [
            { value: [] },
            {
              rule: { __resolveType: "website/matchers/device.ts" },
              value: [],
            },
          ],
        },
      },
    };

    expect(getPageVariantCount(decofile, "home")).toBe(1);
    expect(getPageVariantCount(decofile, "promo")).toBe(2);
  });

  it("v7: appends a variant seeded from provided sections", () => {
    const seed = [{ __resolveType: "site/sections/Hero.tsx" }];
    const result = appendPageVariantSections([{ __resolveType: "A" }], seed);
    expect(result).toEqual({
      sections: {
        __resolveType: "website/flags/multivariate.ts",
        variants: [
          {
            rule: { __resolveType: "website/matchers/always.ts" },
            value: [{ __resolveType: "A" }],
          },
          {
            rule: { __resolveType: "website/matchers/always.ts" },
            value: seed,
          },
        ],
      },
      newVariantIndex: 1,
    });
  });

  it("v7: appends after a trailing catch-all and selects the last", () => {
    const mobile = {
      rule: { __resolveType: "website/matchers/device.ts", mobile: true },
      value: [{ __resolveType: "Mobile" }],
    };
    const fallback = {
      rule: { __resolveType: "website/matchers/always.ts" },
      value: [{ __resolveType: "Default" }],
    };
    const seed = [{ __resolveType: "Seed" }];
    const result = appendPageVariantSections(
      {
        __resolveType: "website/flags/multivariate.ts",
        variants: [mobile, fallback],
      },
      seed,
    );
    expect(result?.newVariantIndex).toBe(2);
    const variants = (result?.sections.variants ?? []) as Array<{
      value: unknown;
    }>;
    expect(variants.map((variant) => variant.value)).toEqual([
      mobile.value,
      fallback.value,
      seed,
    ]);
    // A page with no sections shape gets an empty first variant, as before.
    expect(appendPageVariantSections(undefined, seed)).toEqual({
      sections: {
        __resolveType: "website/flags/multivariate.ts",
        variants: [
          { rule: { __resolveType: "website/matchers/always.ts" }, value: [] },
          {
            rule: { __resolveType: "website/matchers/always.ts" },
            value: seed,
          },
        ],
      },
      newVariantIndex: 1,
    });
  });

  it("v7: duplicates a page variant right after it", () => {
    const mobile = {
      rule: { __resolveType: "website/matchers/device.ts", mobile: true },
      value: [{ __resolveType: "Mobile" }],
    };
    const fallback = {
      rule: { __resolveType: "website/matchers/always.ts" },
      value: [{ __resolveType: "Default" }],
    };
    const next = duplicatePageVariantEntry([mobile, fallback], 1);
    expect(next?.[1]).toBe(fallback);
    expect(next?.[2]).toEqual(fallback);
    expect(next?.[2]).not.toBe(fallback);
  });

  it("v8: adds a variant seeded from provided sections above the current ones", () => {
    const seed = [{ __resolveType: "site/sections/Hero.tsx" }];
    const result = appendPageVariantSections(
      [{ __resolveType: "A" }],
      seed,
      undefined,
      true,
    );
    expect(result).toEqual({
      sections: {
        __resolveType: "website/flags/multivariate.ts",
        variants: [
          {
            rule: { __resolveType: "website/matchers/always.ts" },
            value: seed,
          },
          {
            rule: { __resolveType: "website/matchers/always.ts" },
            value: [{ __resolveType: "A" }],
          },
        ],
      },
      newVariantIndex: 0,
    });
  });

  it("v8: adds a page variant above a trailing catch-all, keeping the order", () => {
    const mobile = {
      rule: { __resolveType: "website/matchers/device.ts", mobile: true },
      value: [{ __resolveType: "Mobile" }],
    };
    const fallback = {
      rule: { __resolveType: "website/matchers/always.ts" },
      value: [{ __resolveType: "Default" }],
    };
    const seed = [{ __resolveType: "Seed" }];
    const result = appendPageVariantSections(
      {
        __resolveType: "website/flags/multivariate.ts",
        variants: [mobile, fallback],
      },
      seed,
      undefined,
      true,
    );
    expect(result?.newVariantIndex).toBe(1);
    const variants = (result?.sections.variants ?? []) as Array<{
      value: unknown;
    }>;
    expect(variants.map((variant) => variant.value)).toEqual([
      mobile.value,
      seed,
      fallback.value,
    ]);
  });

  it("appends a page variant at the end with no trailing catch-all", () => {
    const mobile = {
      rule: { __resolveType: "website/matchers/device.ts", mobile: true },
      value: [{ __resolveType: "Mobile" }],
    };
    for (const v8 of [true, false]) {
      const result = appendPageVariantSections(
        { __resolveType: "website/flags/multivariate.ts", variants: [mobile] },
        [{ __resolveType: "Seed" }],
        undefined,
        v8,
      );
      expect(result?.newVariantIndex).toBe(1);
      expect(result?.sections.variants).toHaveLength(2);
    }
  });

  it("v8: duplicates the catch-all page variant above it", () => {
    const mobile = {
      rule: { __resolveType: "website/matchers/device.ts", mobile: true },
      value: [{ __resolveType: "Mobile" }],
    };
    const fallback = {
      rule: { __resolveType: "website/matchers/always.ts" },
      value: [{ __resolveType: "Default" }],
    };
    const next = duplicatePageVariantEntry([mobile, fallback], 1, true);
    expect(next?.[2]).toBe(fallback);
    expect(next?.[1]).toEqual(fallback);
    expect(duplicatePageVariantEntry([mobile, fallback], 0, true)?.[1]).toEqual(
      mobile,
    );
  });

  it("keeps multivariate shape when the last variant has a rule", () => {
    const obj = { __resolveType: "website/flags/multivariate.ts" };
    const variants = [
      {
        rule: { __resolveType: "website/matchers/device.ts", mobile: true },
        value: [{ __resolveType: "A" }],
      },
    ];

    expect(buildPageSectionsFromVariants(obj, variants)).toEqual({
      ...obj,
      variants,
    });
    expect(variantHasRule(variants[0])).toBe(true);
  });

  it("collapses to a flat array when the last variant has the default rule", () => {
    const obj = { __resolveType: "website/flags/multivariate.ts" };
    const variants = [
      {
        rule: { __resolveType: "website/matchers/always.ts" },
        value: [{ __resolveType: "A" }],
      },
    ];

    expect(buildPageSectionsFromVariants(obj, variants)).toEqual([
      { __resolveType: "A" },
    ]);
  });
});

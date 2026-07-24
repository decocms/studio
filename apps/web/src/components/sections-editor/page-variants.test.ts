import { describe, expect, it } from "bun:test";
import {
  appendPageVariantSections,
  buildPageSectionsFromVariants,
  countSavedMatcherBlockReferences,
  getPageVariantCount,
  getPageVariantSectionsAt,
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
      isSectionMultivariateWrapperValue({
        __resolveType: SECTION_MULTIVARIATE_RESOLVE_TYPE,
        variants: [
          { value: { __resolveType: "site/sections/Header.tsx" }, rule: {} },
          { value: { __resolveType: "site/sections/Header.tsx" }, rule: {} },
        ],
      }),
    ).toBe(true);
  });

  it("rejects the page-level multivariate flag wrapper", () => {
    expect(
      isSectionMultivariateWrapperValue({
        __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
        variants: [{ value: [], rule: {} }],
      }),
    ).toBe(false);
  });

  it("rejects plain arrays, primitives, and non-wrapper objects", () => {
    expect(isSectionMultivariateWrapperValue([])).toBe(false);
    expect(isSectionMultivariateWrapperValue(null)).toBe(false);
    expect(isSectionMultivariateWrapperValue("x")).toBe(false);
    expect(
      isSectionMultivariateWrapperValue({
        __resolveType: SECTION_MULTIVARIATE_RESOLVE_TYPE,
      }),
    ).toBe(false);
    expect(
      isSectionMultivariateWrapperValue({
        __resolveType: "site/sections/Header.tsx",
        variants: [],
      }),
    ).toBe(false);
  });
});

describe("page-variants", () => {
  it("unwraps multivariate global section arrays", () => {
    const sections = [
      { __resolveType: "Analytics" },
      { __resolveType: "Minicart" },
    ];
    expect(unwrapMultivariateArrayValue(sections)).toBeNull();
    expect(
      unwrapMultivariateArrayValue({
        __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
        variants: [{ value: sections }],
      }),
    ).toEqual(sections);
    expect(
      unwrapMultivariateArrayValue({
        __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
        variants: "not-an-array",
      }),
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
    expect(wrapMultivariateArrayValue(original, next)).toEqual({
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

  it("appends a variant seeded from provided sections", () => {
    const seed = [{ __resolveType: "site/sections/Hero.tsx" }];
    const result = appendPageVariantSections([{ __resolveType: "A" }], seed);
    expect(result).toEqual({
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
    });
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

  it("counts saved matcher block references across pages", () => {
    const decofile = {
      MobilePromo: {
        __resolveType: "website/matchers/device.ts",
        mobile: true,
        name: "Mobile Promo",
      },
      home: {
        __resolveType: "website/pages/Page.tsx",
        path: "/",
        sections: {
          variants: [
            { rule: { __resolveType: "MobilePromo" }, value: [] },
            {
              rule: { __resolveType: "website/matchers/always.ts" },
              value: [],
            },
          ],
        },
      },
    };

    expect(countSavedMatcherBlockReferences(decofile, "MobilePromo")).toBe(1);
    expect(
      countSavedMatcherBlockReferences(decofile, "website/matchers/always.ts"),
    ).toBe(0);
  });
});

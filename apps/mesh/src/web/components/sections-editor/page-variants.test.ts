import { describe, expect, it } from "bun:test";
import {
  appendPageVariantSections,
  buildPageSectionsFromVariants,
  countSavedMatcherBlockReferences,
  getPageVariantCount,
  variantHasRule,
} from "./page-variants";

describe("page-variants", () => {
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
      variants: [{ value: [{ __resolveType: "A" }] }, { value: seed }],
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

  it("collapses to a flat array when the last variant has no rule", () => {
    const obj = { __resolveType: "website/flags/multivariate.ts" };
    const variants = [{ value: [{ __resolveType: "A" }] }];

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

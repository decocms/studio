import { describe, expect, it } from "bun:test";
import {
  appendPageVariantSections,
  duplicatePageVariantEntry,
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

  it("adds a variant seeded from provided sections above the current ones", () => {
    const seed = [{ __resolveType: "site/sections/Hero.tsx" }];
    const result = appendPageVariantSections([{ __resolveType: "A" }], seed);
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

  it("adds a page variant above a trailing catch-all, keeping the order", () => {
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
    const result = appendPageVariantSections(
      { __resolveType: "website/flags/multivariate.ts", variants: [mobile] },
      [{ __resolveType: "Seed" }],
    );
    expect(result?.newVariantIndex).toBe(1);
    expect(result?.sections.variants).toHaveLength(2);
  });

  it("duplicates the catch-all page variant above it", () => {
    const mobile = {
      rule: { __resolveType: "website/matchers/device.ts", mobile: true },
      value: [{ __resolveType: "Mobile" }],
    };
    const fallback = {
      rule: { __resolveType: "website/matchers/always.ts" },
      value: [{ __resolveType: "Default" }],
    };
    const next = duplicatePageVariantEntry([mobile, fallback], 1);
    expect(next?.[2]).toBe(fallback);
    expect(next?.[1]).toEqual(fallback);
    expect(duplicatePageVariantEntry([mobile, fallback], 0)?.[1]).toEqual(
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

/**
 * The count gates deletion of a saved matcher block, so every position a
 * reference can occupy has to be found — a miss deletes a live block.
 */
describe("countSavedMatcherBlockReferences", () => {
  const savedMatcher = {
    __resolveType: "website/matchers/device.ts",
    mobile: true,
    name: "Mobile Promo",
  };
  /** Fresh object per call — the walk memoizes identity. */
  const ref = () => ({ __resolveType: "MobilePromo" });
  const page = (sections: unknown) => ({
    __resolveType: "website/pages/Page.tsx",
    path: "/",
    sections,
  });

  it("counts a reference on a plain page variant rule", () => {
    const decofile = {
      MobilePromo: savedMatcher,
      home: page({
        variants: [
          { rule: ref(), value: [] },
          { rule: { __resolveType: "website/matchers/always.ts" }, value: [] },
        ],
      }),
    };

    expect(countSavedMatcherBlockReferences(decofile, "MobilePromo")).toBe(1);
    expect(
      countSavedMatcherBlockReferences(decofile, "website/matchers/always.ts"),
    ).toBe(0);
  });

  it("counts a reference nested inside a multi matcher", () => {
    const decofile = {
      MobilePromo: savedMatcher,
      home: page({
        __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
        variants: [
          {
            rule: {
              __resolveType: "website/matchers/multi.ts",
              op: "and",
              matchers: [
                ref(),
                { __resolveType: "website/matchers/date.ts", start: "2026-01" },
              ],
            },
            value: [],
          },
        ],
      }),
    };

    expect(countSavedMatcherBlockReferences(decofile, "MobilePromo")).toBe(1);
  });

  it("counts references two levels deep in nested multi matchers", () => {
    const decofile = {
      MobilePromo: savedMatcher,
      home: page({
        __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
        variants: [
          {
            rule: {
              __resolveType: "website/matchers/multi.ts",
              op: "or",
              matchers: [
                {
                  __resolveType: "$live/matchers/MatchMulti.ts",
                  op: "and",
                  matchers: [ref(), ref()],
                },
              ],
            },
            value: [],
          },
        ],
      }),
    };

    expect(countSavedMatcherBlockReferences(decofile, "MobilePromo")).toBe(2);
  });

  it("counts a reference on a section variant rule inside a page", () => {
    const decofile = {
      MobilePromo: savedMatcher,
      home: page([
        { __resolveType: "site/sections/Header.tsx" },
        {
          __resolveType: SECTION_MULTIVARIATE_RESOLVE_TYPE,
          variants: [
            { rule: ref(), value: { __resolveType: "site/sections/Hero.tsx" } },
          ],
        },
      ]),
    };

    expect(countSavedMatcherBlockReferences(decofile, "MobilePromo")).toBe(1);
  });

  it("counts a reference on a field-level multivariate rule nested in a block", () => {
    const decofile = {
      MobilePromo: savedMatcher,
      Alerta: {
        __resolveType: "site/sections/Content/Alert.tsx",
        banners: [
          {
            image: {
              __resolveType: "website/flags/multivariate/image.ts",
              variants: [{ rule: ref(), value: "https://example.com/a.png" }],
            },
          },
        ],
      },
    };

    expect(countSavedMatcherBlockReferences(decofile, "MobilePromo")).toBe(1);
  });

  it("counts a reference inside a saved global section that wraps variants", () => {
    const decofile = {
      MobilePromo: savedMatcher,
      "Category Banner - 01": {
        __resolveType: SECTION_MULTIVARIATE_RESOLVE_TYPE,
        variants: [
          { rule: ref(), value: { __resolveType: "site/sections/Banner.tsx" } },
        ],
      },
    };

    expect(countSavedMatcherBlockReferences(decofile, "MobilePromo")).toBe(1);
  });

  it("counts a reference from another saved matcher block", () => {
    const decofile = {
      MobilePromo: savedMatcher,
      "Mobile And Summer": {
        __resolveType: "website/matchers/multi.ts",
        op: "and",
        matchers: [ref(), { __resolveType: "website/matchers/date.ts" }],
        name: "Mobile and summer",
      },
    };

    expect(countSavedMatcherBlockReferences(decofile, "MobilePromo")).toBe(1);
  });

  it("ignores a self-reference in the block's own body", () => {
    const decofile = {
      MobilePromo: {
        __resolveType: "website/matchers/multi.ts",
        op: "and",
        matchers: [ref()],
        name: "Mobile Promo",
      },
    };

    expect(countSavedMatcherBlockReferences(decofile, "MobilePromo")).toBe(0);
  });

  it("terminates on a cyclic decofile and still finds the reference", () => {
    const cyclic: Record<string, unknown> = {
      __resolveType: SECTION_MULTIVARIATE_RESOLVE_TYPE,
      variants: [{ rule: ref(), value: null }],
    };
    cyclic.self = cyclic;
    (cyclic.variants as Array<Record<string, unknown>>)[0]!.parent = cyclic;

    const decofile = {
      MobilePromo: savedMatcher,
      Loop: cyclic,
    };

    expect(countSavedMatcherBlockReferences(decofile, "MobilePromo")).toBe(1);
  });

  it("tolerates malformed values and finds deeply nested references", () => {
    const decofile = {
      MobilePromo: savedMatcher,
      nothing: null,
      aNumber: 3,
      aString: "MobilePromo",
      anArray: [undefined, [[[{ rule: ref() }]]]],
      noResolveType: { variants: [{ rule: ref() }] },
    };

    expect(countSavedMatcherBlockReferences(decofile, "MobilePromo")).toBe(2);
    expect(countSavedMatcherBlockReferences(decofile, "")).toBe(0);
  });

  it("counts an object reachable from two positions once", () => {
    const shared = { rule: ref(), value: [] };
    const decofile = {
      MobilePromo: savedMatcher,
      home: page({
        __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
        variants: [shared],
      }),
      about: page({
        __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
        variants: [shared],
      }),
    };

    expect(countSavedMatcherBlockReferences(decofile, "MobilePromo")).toBe(1);
  });

  it("counts a v7 site's saved random matcher across pages, sections and multi", () => {
    const meta = {
      manifest: {
        blocks: {
          matchers: {
            "website/matchers/random.ts": { $ref: "#/definitions/random" },
            "website/matchers/multi.ts": { $ref: "#/definitions/multi" },
          },
          pages: { "website/pages/Page.tsx": { $ref: "#/definitions/page" } },
        },
      },
      schema: {},
    };
    const decofile = {
      "Hero Test": {
        __resolveType: "website/matchers/random.ts",
        traffic: 0.5,
        name: "Hero Test",
      },
      home: page({
        __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
        variants: [
          { rule: { __resolveType: "Hero Test" }, value: [] },
          { rule: { __resolveType: "website/matchers/always.ts" }, value: [] },
        ],
      }),
      about: page([
        {
          __resolveType: SECTION_MULTIVARIATE_RESOLVE_TYPE,
          variants: [
            {
              rule: {
                __resolveType: "website/matchers/multi.ts",
                op: "or",
                matchers: [{ __resolveType: "Hero Test" }],
              },
              value: { __resolveType: "site/sections/Hero.tsx" },
            },
          ],
        },
      ]),
    };

    expect(countSavedMatcherBlockReferences(decofile, "Hero Test", meta)).toBe(
      2,
    );
  });

  it("counts a reference inside a v8 section variant within a page variant's lazy list", () => {
    const decofile = {
      MobilePromo: savedMatcher,
      home: page({
        __resolveType: "multivariate",
        variants: [
          {
            rule: { __resolveType: "always" },
            value: {
              __resolveType: "lazy",
              value: [
                {
                  __resolveType: "multivariate",
                  variants: [
                    {
                      rule: ref(),
                      value: { __resolveType: "lazy", value: { title: "a" } },
                    },
                  ],
                },
              ],
            },
          },
        ],
      }),
    };

    expect(countSavedMatcherBlockReferences(decofile, "MobilePromo")).toBe(1);
  });

  it("returns 0 for a genuinely orphaned block so cleanup can delete it", () => {
    const decofile = {
      MobilePromo: savedMatcher,
      DesktopPromo: {
        __resolveType: "website/matchers/device.ts",
        desktop: true,
        name: "Desktop Promo",
      },
      home: page({
        __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
        variants: [
          { rule: { __resolveType: "DesktopPromo" }, value: [] },
          {
            rule: {
              __resolveType: "website/matchers/multi.ts",
              matchers: [{ __resolveType: "DesktopPromo" }],
            },
            value: [],
          },
        ],
      }),
      Alerta: {
        __resolveType: SECTION_MULTIVARIATE_RESOLVE_TYPE,
        variants: [
          {
            rule: { __resolveType: "website/matchers/always.ts" },
            value: { __resolveType: "site/sections/Alert.tsx" },
          },
        ],
      },
    };

    expect(countSavedMatcherBlockReferences(decofile, "MobilePromo")).toBe(0);
    expect(countSavedMatcherBlockReferences(decofile, "DesktopPromo")).toBe(2);
  });
});

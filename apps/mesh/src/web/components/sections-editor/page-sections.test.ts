import { describe, expect, it } from "bun:test";
import {
  buildPageDataWithSections,
  suggestBlockId,
  validateBlockId,
} from "./page-sections";

describe("page-sections", () => {
  it("buildPageDataWithSections replaces a flat sections array", () => {
    const decofile = {
      Home: {
        name: "Home",
        sections: [{ __resolveType: "site/sections/Hero.tsx" }],
      },
    };
    const updated = [{ __resolveType: "Header" }];

    expect(
      buildPageDataWithSections(decofile, "Home", updated, 0, [
        { label: "Default", sections: updated },
      ]).sections,
    ).toEqual(updated);
  });

  it("buildPageDataWithSections updates a multivariate page variant", () => {
    const decofile = {
      Home: {
        sections: {
          variants: [
            {
              rule: { __resolveType: "website/matchers/always.ts" },
              value: [{ __resolveType: "A" }],
            },
            {
              rule: {
                __resolveType: "website/matchers/device.ts",
                mobile: true,
              },
              value: [{ __resolveType: "B" }],
            },
          ],
        },
      },
    };
    const pageVariants = [
      { label: "Default", sections: [{ __resolveType: "A" }] },
      { label: "Mobile", sections: [{ __resolveType: "B" }] },
    ];
    const updated = [{ __resolveType: "MobileHero" }];

    const result = buildPageDataWithSections(
      decofile,
      "Home",
      updated,
      1,
      pageVariants,
    ) as {
      sections: {
        variants: Array<{ value: unknown }>;
      };
    };

    expect(result.sections.variants[1]?.value).toEqual(updated);
    expect(result.sections.variants[0]?.value).toEqual([
      { __resolveType: "A" },
    ]);
  });

  it("validateBlockId rejects invalid and duplicate ids", () => {
    const decofile = { Header: { __resolveType: "site/sections/Header.tsx" } };

    expect(validateBlockId("", decofile)).toBe("Block name is required.");
    expect(validateBlockId("site/sections/Hero", decofile)).toContain(
      "slashes",
    );
    expect(validateBlockId("Header", decofile)).toContain("already exists");
    expect(validateBlockId("1Hero", decofile)).toContain(
      "Must start with a letter",
    );
    expect(validateBlockId("MyNewBlock", decofile)).toBeNull();
  });

  it("suggestBlockId sanitizes labels", () => {
    expect(suggestBlockId("Hero")).toBe("Hero");
    expect(suggestBlockId("Variants of Hero")).toBe("VariantsofHero");
    expect(suggestBlockId("FAQ Section")).toBe("FAQSection");
  });
});

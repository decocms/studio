import { describe, expect, it } from "bun:test";
import {
  deleteMultivariateSectionVariant,
  duplicateMultivariateSectionVariant,
  flattenMultivariateSection,
  getMultivariateSectionObject,
  hideSection,
  isDefaultVariantRule,
  parseSectionFlagVariants,
  pickVariantToKeepIndex,
  showSection,
  unwrapVariantSectionValue,
  updateMultivariateSectionVariantValue,
  writeVariantSectionValue,
} from "./section-variants";
import { parseSections } from "./parse-sections";

describe("section-variants", () => {
  it("getMultivariateSectionObject unwraps lazy multivariate sections", () => {
    const raw = {
      __resolveType: "website/sections/Rendering/Lazy.tsx",
      section: {
        __resolveType: "website/flags/multivariate/section.ts",
        variants: [],
      },
    };

    expect(
      getMultivariateSectionObject(raw, {
        isLazy: true,
        isMultivariate: true,
      })?.__resolveType,
    ).toBe("website/flags/multivariate/section.ts");
  });

  it("parseSectionFlagVariants labels variants from matcher rules", () => {
    const mvObj = {
      __resolveType: "website/flags/multivariate/section.ts",
      variants: [
        {
          rule: { __resolveType: "website/matchers/always.ts" },
          value: { __resolveType: "site/sections/Hero.tsx" },
        },
        {
          rule: {
            __resolveType: "website/matchers/device.ts",
            mobile: true,
          },
          value: { __resolveType: "site/sections/Hero.tsx", title: "Mobile" },
        },
      ],
    };

    const variants = parseSectionFlagVariants(mvObj, (rule) =>
      rule?.__resolveType === "website/matchers/device.ts"
        ? "Mobile"
        : "Default",
    );

    expect(variants).toHaveLength(2);
    expect(variants[0]?.label).toBe("Default");
    expect(variants[1]?.label).toBe("Mobile");
  });

  it("unwrapVariantSectionValue reads inline and lazy variant payloads", () => {
    const decofile = {
      Header: {
        __resolveType: "site/sections/Header.tsx",
        title: "Global header",
      },
    };

    expect(
      unwrapVariantSectionValue(
        { __resolveType: "site/sections/Hero.tsx", title: "Hero" },
        decofile,
      )?.resolveType,
    ).toBe("site/sections/Hero.tsx");

    expect(
      unwrapVariantSectionValue(
        {
          __resolveType: "website/sections/Rendering/Lazy.tsx",
          section: { __resolveType: "Header" },
        },
        decofile,
      )?.data.title,
    ).toBe("Global header");
  });

  it("writeVariantSectionValue preserves lazy wrappers", () => {
    const original = {
      __resolveType: "website/sections/Rendering/Lazy.tsx",
      section: { __resolveType: "site/sections/Hero.tsx", title: "A" },
    };

    expect(
      writeVariantSectionValue(original, {
        __resolveType: "site/sections/Hero.tsx",
        title: "B",
      }),
    ).toEqual({
      __resolveType: "website/sections/Rendering/Lazy.tsx",
      section: { __resolveType: "site/sections/Hero.tsx", title: "B" },
    });
  });

  it("updateMultivariateSectionVariantValue updates one variant value", () => {
    const mvObj = {
      __resolveType: "website/flags/multivariate/section.ts",
      variants: [
        {
          value: { __resolveType: "site/sections/Hero.tsx", title: "A" },
        },
        {
          value: { __resolveType: "site/sections/Hero.tsx", title: "B" },
        },
      ],
    };

    const updated = updateMultivariateSectionVariantValue(mvObj, 1, {
      __resolveType: "site/sections/Hero.tsx",
      title: "Updated",
    }) as {
      variants: Array<{ value: { title: string } }>;
    };

    expect(updated.variants[0]?.value.title).toBe("A");
    expect(updated.variants[1]?.value.title).toBe("Updated");
  });

  it("duplicateMultivariateSectionVariant inserts a clone after the source", () => {
    const mvObj = {
      __resolveType: "website/flags/multivariate/section.ts",
      variants: [
        {
          rule: { __resolveType: "website/matchers/always.ts" },
          value: { __resolveType: "site/sections/Hero.tsx", title: "A" },
        },
        {
          rule: {
            __resolveType: "website/matchers/device.ts",
            mobile: true,
          },
          value: { __resolveType: "site/sections/Hero.tsx", title: "B" },
        },
      ],
    };

    const updated = duplicateMultivariateSectionVariant(mvObj, 0) as {
      variants: Array<{ value: { title: string } }>;
    };

    expect(updated.variants).toHaveLength(3);
    expect(updated.variants[0]?.value.title).toBe("A");
    expect(updated.variants[1]?.value.title).toBe("A");
    expect(updated.variants[2]?.value.title).toBe("B");
  });

  it("deleteMultivariateSectionVariant removes a variant but keeps at least one", () => {
    const mvObj = {
      __resolveType: "website/flags/multivariate/section.ts",
      variants: [{ value: { title: "A" } }, { value: { title: "B" } }],
    };

    const updated = deleteMultivariateSectionVariant(mvObj, 1) as {
      variants: Array<{ value: { title: string } }>;
    };

    expect(updated.variants).toHaveLength(1);
    expect(updated.variants[0]?.value.title).toBe("A");
    expect(deleteMultivariateSectionVariant(updated, 0)).toBeNull();
  });

  it("isDefaultVariantRule treats always matchers as default", () => {
    expect(isDefaultVariantRule(undefined)).toBe(false);
    expect(isDefaultVariantRule({})).toBe(true);
    expect(
      isDefaultVariantRule({ __resolveType: "website/matchers/always.ts" }),
    ).toBe(true);
    expect(
      isDefaultVariantRule({
        __resolveType: "website/matchers/device.ts",
        mobile: true,
      }),
    ).toBe(false);
  });

  it("pickVariantToKeepIndex prefers default and falls back to last", () => {
    const mvObj = {
      variants: [
        {
          rule: {
            __resolveType: "website/matchers/device.ts",
            mobile: true,
          },
          value: { title: "Mobile" },
        },
        {
          rule: { __resolveType: "website/matchers/always.ts" },
          value: { title: "Default" },
        },
      ],
    };

    expect(pickVariantToKeepIndex(mvObj)).toBe(1);

    const withoutDefault = {
      variants: [{ value: { title: "A" } }, { value: { title: "B" } }],
    };
    expect(pickVariantToKeepIndex(withoutDefault)).toBe(1);
  });

  it("flattenMultivariateSection keeps default variant and preserves lazy wrappers", () => {
    const mvObj = {
      __resolveType: "website/flags/multivariate/section.ts",
      variants: [
        {
          rule: { __resolveType: "website/matchers/device.ts", mobile: true },
          value: { __resolveType: "site/sections/Hero.tsx", title: "Mobile" },
        },
        {
          rule: { __resolveType: "website/matchers/always.ts" },
          value: { __resolveType: "site/sections/Hero.tsx", title: "Default" },
        },
      ],
    };

    expect(
      flattenMultivariateSection(mvObj as never, { isLazy: false }, mvObj),
    ).toEqual({
      __resolveType: "site/sections/Hero.tsx",
      title: "Default",
    });

    const lazyRaw = {
      __resolveType: "website/sections/Rendering/Lazy.tsx",
      section: mvObj,
    };

    expect(
      flattenMultivariateSection(lazyRaw as never, { isLazy: true }, mvObj),
    ).toEqual({
      __resolveType: "website/sections/Rendering/Lazy.tsx",
      section: {
        __resolveType: "site/sections/Hero.tsx",
        title: "Default",
      },
    });
  });

  it("hideSection produces a section parsed as hidden", () => {
    const hidden = hideSection({
      __resolveType: "site/sections/Hero.tsx",
      title: "Hero",
    });

    expect(parseSections([hidden], {})[0]?.isHidden).toBe(true);
  });

  it("hideSection/showSection round-trips normal, lazy-outer, and saved-block sections", () => {
    // hideSection wraps outside the lazy shell, so the lazy section is stored
    // verbatim as variants[0].value — showSection extracts it directly without
    // touching the outerLazy branch.
    const cases = [
      { __resolveType: "site/sections/Hero.tsx", title: "Hero" },
      {
        __resolveType: "website/sections/Rendering/Lazy.tsx",
        section: { __resolveType: "site/sections/Hero.tsx", title: "Lazy" },
      },
      // saved-block: bare resolve-type key with no "/"; showSection has no
      // special saved-block logic — it extracts variants[0].value like any section.
      { __resolveType: "Header" },
    ];

    for (const original of cases) {
      const restored = showSection(hideSection(original as never));
      expect(restored).toEqual(original as never);
    }
  });

  it("showSection unwraps a lazy-outer hidden section (outerLazy branch)", () => {
    // Data shape: lazy(multivariate(never(section))) — the multivariate lives
    // inside the lazy shell rather than outside. showSection's outerLazy branch
    // handles this by peering into raw.section before reading variants.
    const lazyOuter = {
      __resolveType: "website/sections/Rendering/Lazy.tsx",
      section: {
        __resolveType: "website/flags/multivariate/section.ts",
        variants: [
          {
            value: { __resolveType: "site/sections/Hero.tsx", title: "Inner" },
            rule: { __resolveType: "website/matchers/never.ts" },
          },
        ],
      },
    };
    expect(showSection(lazyOuter as never)).toEqual({
      __resolveType: "site/sections/Hero.tsx",
      title: "Inner",
    });
  });

  it("showSection returns null when the section is not hidden (no never rule)", () => {
    expect(
      showSection({ __resolveType: "site/sections/Hero.tsx" } as never),
    ).toBeNull();
  });

  it("showSection returns null when the variant rule is not a never matcher", () => {
    expect(
      showSection({
        __resolveType: "website/flags/multivariate/section.ts",
        variants: [
          {
            value: { __resolveType: "site/sections/Hero.tsx" },
            rule: { __resolveType: "website/matchers/always.ts" },
          },
        ],
      } as never),
    ).toBeNull();
  });

  it("showSection returns null when there are no variants", () => {
    expect(
      showSection({
        __resolveType: "website/flags/multivariate/section.ts",
        variants: [],
      } as never),
    ).toBeNull();
  });
});

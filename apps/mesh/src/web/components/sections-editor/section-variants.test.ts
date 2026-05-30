import { describe, expect, it } from "bun:test";
import {
  deleteMultivariateSectionVariant,
  duplicateMultivariateSectionVariant,
  flattenMultivariateSection,
  getMultivariateSectionObject,
  isDefaultVariantRule,
  parseSectionFlagVariants,
  pickVariantToKeepIndex,
  unwrapVariantSectionValue,
  updateMultivariateSectionVariantValue,
  writeVariantSectionValue,
} from "./section-variants";

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
});

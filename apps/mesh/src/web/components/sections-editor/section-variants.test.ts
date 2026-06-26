import { describe, expect, it } from "bun:test";
import {
  appendSectionVariant,
  canAddSectionVariant,
  deleteMultivariateSectionVariant,
  duplicateMultivariateSectionVariant,
  flattenMultivariateSection,
  getMultivariateSectionObject,
  hideSection,
  isDefaultVariantRule,
  parseSectionFlagVariants,
  pickVariantToKeepIndex,
  reorderMultivariateSectionVariant,
  showSection,
  toggleSectionLazyRender,
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

  it("reorderMultivariateSectionVariant moves a variant and preserves the rest", () => {
    const mvObj = {
      __resolveType: "website/flags/multivariate/section.ts",
      variants: [
        { value: { title: "A" } },
        { value: { title: "B" } },
        { value: { title: "C" } },
      ],
    };

    const moved = reorderMultivariateSectionVariant(mvObj, 0, 2) as {
      variants: Array<{ value: { title: string } }>;
    };
    expect(moved.variants.map((v) => v.value.title)).toEqual(["B", "C", "A"]);

    // out-of-range / no-op returns the original object
    expect(reorderMultivariateSectionVariant(mvObj, 1, 1)).toBe(mvObj);
    expect(reorderMultivariateSectionVariant(mvObj, 0, 9)).toBe(mvObj);
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

  it("hideSection/showSection round-trips normal and saved-block sections", () => {
    const cases = [
      { __resolveType: "site/sections/Hero.tsx", title: "Hero" },
      { __resolveType: "Header" },
    ];

    for (const original of cases) {
      const restored = showSection(hideSection(original as never));
      expect(restored).toEqual(original as never);
    }
  });

  it("hideSection on lazy sections stores the core section, not the lazy wrapper", () => {
    const lazy = {
      __resolveType: "website/sections/Rendering/Lazy.tsx",
      section: { __resolveType: "site/sections/Hero.tsx", title: "Lazy" },
    };
    const hidden = hideSection(lazy as never);

    expect(hidden).toEqual({
      __resolveType: "website/flags/multivariate/section.ts",
      variants: [
        {
          value: { __resolveType: "site/sections/Hero.tsx", title: "Lazy" },
          rule: { __resolveType: "website/matchers/never.ts" },
        },
      ],
    });
    expect(showSection(hidden as never)).toEqual({
      __resolveType: "site/sections/Hero.tsx",
      title: "Lazy",
    });
  });

  it("lazy and hidden wrappers are mutually exclusive", () => {
    const hero = { __resolveType: "site/sections/Hero.tsx", title: "Hero" };
    const lazy = {
      __resolveType: "website/sections/Rendering/Lazy.tsx",
      section: hero,
    };

    expect(
      toggleSectionLazyRender(hideSection(hero as never) as never),
    ).toEqual(lazy);
    expect(hideSection(lazy as never)).toEqual({
      __resolveType: "website/flags/multivariate/section.ts",
      variants: [
        {
          value: hero,
          rule: { __resolveType: "website/matchers/never.ts" },
        },
      ],
    });
  });

  it("toggleSectionLazyRender wraps and unwraps plain sections", () => {
    const hero = { __resolveType: "site/sections/Hero.tsx", title: "Hi" };
    const lazy = {
      __resolveType: "website/sections/Rendering/Lazy.tsx",
      section: hero,
    };

    expect(toggleSectionLazyRender(hero as never)).toEqual(lazy);
    expect(toggleSectionLazyRender(lazy as never)).toEqual(hero);
    expect(toggleSectionLazyRender({} as never)).toBeNull();
  });

  it("toggleSectionLazyRender on hidden unwraps never-matcher before lazy-wrapping", () => {
    const hero = { __resolveType: "site/sections/Hero.tsx" };
    const hidden = hideSection(hero as never);

    expect(toggleSectionLazyRender(hidden as never)).toEqual({
      __resolveType: "website/sections/Rendering/Lazy.tsx",
      section: hero,
    });
  });

  it("toggleSectionLazyRender on legacy hidden+lazy keeps the lazy shell", () => {
    const lazyHero = {
      __resolveType: "website/sections/Rendering/Lazy.tsx",
      section: { __resolveType: "site/sections/Hero.tsx", title: "Hero" },
    };
    const legacyHidden = {
      __resolveType: "website/flags/multivariate/section.ts",
      variants: [
        {
          value: lazyHero,
          rule: { __resolveType: "website/matchers/never.ts" },
        },
      ],
    };

    expect(toggleSectionLazyRender(legacyHidden as never)).toEqual(lazyHero);
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

  it("appendSectionVariant wraps a plain section with two variants", () => {
    const hero = {
      __resolveType: "site/sections/Hero.tsx",
      title: "Hello",
    } as never;

    const result = appendSectionVariant(hero, {
      index: 0,
      resolveType: "site/sections/Hero.tsx",
      label: "Hero",
    });

    expect(result?.newVariantIndex).toBe(1);
    expect(result?.section).toEqual({
      __resolveType: "website/flags/multivariate/section.ts",
      variants: [
        {
          rule: { __resolveType: "website/matchers/always.ts" },
          value: hero,
        },
        {
          rule: { __resolveType: "website/matchers/always.ts" },
          value: hero,
        },
      ],
    });
    expect(parseSections([result!.section], {})[0]?.isMultivariate).toBe(true);
  });

  it("appendSectionVariant keeps lazy wrapper outside multivariate", () => {
    const lazy = {
      __resolveType: "website/sections/Rendering/Lazy.tsx",
      section: { __resolveType: "site/sections/Hero.tsx", title: "Lazy" },
    } as never;

    const result = appendSectionVariant(lazy, {
      index: 0,
      resolveType: "website/sections/Rendering/Lazy.tsx",
      label: "Hero",
      isLazy: true,
    });

    expect(result?.section.__resolveType).toBe(
      "website/sections/Rendering/Lazy.tsx",
    );
    expect(
      (result?.section.section as Record<string, unknown> | undefined)
        ?.__resolveType,
    ).toBe("website/flags/multivariate/section.ts");
  });

  it("appendSectionVariant extends an existing multivariate section", () => {
    const mvSection = {
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
    } as never;

    const result = appendSectionVariant(mvSection, {
      index: 0,
      resolveType: "website/flags/multivariate/section.ts",
      label: "Variants of Hero",
      isMultivariate: true,
    });

    expect(result?.newVariantIndex).toBe(2);
    expect((result?.section as { variants: unknown[] }).variants).toHaveLength(
      3,
    );
  });

  it("appendSectionVariant rejects hidden sections", () => {
    const hidden = hideSection({
      __resolveType: "site/sections/Hero.tsx",
    } as never);

    expect(
      appendSectionVariant(hidden as never, {
        index: 0,
        resolveType: hidden.__resolveType as string,
        label: "Hero",
        isHidden: true,
      }),
    ).toBeNull();
  });

  it("appendSectionVariant rejects saved-block sections", () => {
    expect(
      appendSectionVariant({ __resolveType: "Header" } as never, {
        index: 0,
        resolveType: "Header",
        label: "Header",
        isSavedBlock: true,
      }),
    ).toBeNull();
  });

  it("canAddSectionVariant blocks hidden and saved-block sections, allows others", () => {
    expect(canAddSectionVariant({ isHidden: true })).toBe(false);
    expect(canAddSectionVariant({ isSavedBlock: true })).toBe(false);
    expect(canAddSectionVariant({ isHidden: false, isSavedBlock: false })).toBe(
      true,
    );
    expect(canAddSectionVariant({})).toBe(true);
    expect(canAddSectionVariant({ isHidden: false })).toBe(true);
  });
});

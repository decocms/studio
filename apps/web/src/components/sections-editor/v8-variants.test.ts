import { describe, expect, test } from "bun:test";
import { createCMS } from "@decocms/blocks";
import { extractScheduledVariants } from "../sandbox/content/variant-calendar/extract-variants";
import { resolveSectionCandidates } from "../sandbox/preview/section-candidates";
import {
  arrayItemDisplayValue,
  hideArrayItem,
  isArrayItemHidden,
  showArrayItem,
} from "./array-item-hidden";
import { extractUrl } from "./fields/extract-url";
import {
  appendVariant,
  flattenMultivariate,
  wrapAsMultivariate,
} from "./fields/media-variants";
import { buildPageDataWithSections } from "./page-sections";
import {
  appendPageVariantSections,
  buildPageSectionsFromVariants,
  getPageVariantSectionsAt,
  isMultivariateArrayWrapper,
  isPageMultivariateSectionArrayField,
  isSectionMultivariateWrapperValue,
  pageMultivariateSectionListSchema,
  parsePageVariants,
  unwrapMultivariateArrayValue,
  wrapMultivariateArrayValue,
} from "./page-variants";
import { parseSections } from "./parse-sections";
import type { LiveMeta, SchemaProperty } from "./resolve-schema";
import { underlyingSectionResolveType } from "./section-catalog";
import type { RawSection } from "./section-types";
import {
  appendSectionVariant,
  flattenMultivariateSection,
  hideSection,
  parseSectionFlagVariants,
  resolveSectionPreviewContext,
  showSection,
  updateMultivariateSectionVariantValue,
} from "./section-variants";
import { unwrapSection } from "./unwrap-section";
import { buildSectionForcedVariants } from "./variant-draft-pointer";
import {
  declaresBuiltinMultivariate,
  sectionMultivariateResolveType,
  valueMultivariateResolveType,
} from "./variant-shape";

/**
 * The manifest `deco schema` (@decocms/blocks 8) writes: the built-ins by
 * short name, each legacy name listed next to them as an alias (the demo
 * storefront's `.deco/schema.gen.json` lists exactly these).
 */
const V8 = {
  blocksMajor: 8,
  manifest: {
    blocks: {
      sections: { hero: {}, footer: {} },
      loaders: {
        lazy: {},
        multivariate: {},
        secret: {},
        "website/flags/multivariate.ts": {},
        "website/flags/multivariate/section.ts": {},
        "website/loaders/secret.ts": {},
      },
      matchers: {
        always: {},
        never: {},
        campaign: {},
        "website/matchers/always.ts": {},
        "website/matchers/never.ts": {},
      },
      pages: {
        page: {},
        "website/pages/Page.tsx": {},
        "$live/pages/LivePage.tsx": {},
      },
    },
  },
  schema: {},
} as LiveMeta;

/** A v7 manifest: file names only, no `multivariate`. */
const V7: LiveMeta = {
  manifest: {
    blocks: {
      sections: { "site/sections/Hero.tsx": {} },
      loaders: {},
      flags: {
        "website/flags/multivariate.ts": {},
        "website/flags/multivariate/section.ts": {},
      },
      matchers: {
        "website/matchers/always.ts": {},
        "website/matchers/never.ts": {},
      },
      pages: { "website/pages/Page.tsx": {} },
    },
  },
  schema: {},
};

const HERO = { __resolveType: "hero", title: "Hi" } as RawSection;
const FOOTER = { __resolveType: "footer" } as RawSection;
const V7_HERO = {
  __resolveType: "site/sections/Hero.tsx",
  title: "Hi",
} as RawSection;

const lazy = (value: unknown) => ({ __resolveType: "lazy", value });
const ALWAYS = { __resolveType: "always" };
const NEVER = { __resolveType: "never" };

describe("which variants block a site gets", () => {
  test("the short multivariate in the schema means v8; otherwise the v7 names", () => {
    expect(declaresBuiltinMultivariate(V8)).toBe(true);
    expect(sectionMultivariateResolveType(V8)).toBe("multivariate");
    expect(valueMultivariateResolveType(V8)).toBe("multivariate");

    expect(declaresBuiltinMultivariate(V7)).toBe(false);
    expect(declaresBuiltinMultivariate(null)).toBe(false);
    expect(sectionMultivariateResolveType(V7)).toBe(
      "website/flags/multivariate/section.ts",
    );
    expect(valueMultivariateResolveType(V7)).toBe(
      "website/flags/multivariate.ts",
    );
    expect(sectionMultivariateResolveType(undefined)).toBe(
      "website/flags/multivariate/section.ts",
    );
  });
});

describe("v8 writers: multivariate, each value in a lazy block", () => {
  test("hiding a section", () => {
    expect(hideSection(HERO, V8)).toEqual({
      __resolveType: "multivariate",
      variants: [{ value: lazy(HERO), rule: NEVER }],
    } as unknown as RawSection);
  });

  test("adding a section variant", () => {
    const [parsed] = parseSections([HERO], {});
    const result = appendSectionVariant(HERO, parsed!, undefined, V8, true);
    expect(result?.newVariantIndex).toBe(0);
    expect(result?.section).toEqual({
      __resolveType: "multivariate",
      variants: [
        { rule: ALWAYS, value: lazy(HERO) },
        { rule: ALWAYS, value: lazy(HERO) },
      ],
    } as unknown as RawSection);

    // A third one, seeded from the form (a plain section), is wrapped too,
    // and goes above the last variant, the catch-all.
    const [mvParsed] = parseSections([result!.section], {}, true);
    const third = appendSectionVariant(
      result!.section,
      mvParsed!,
      { ...HERO, title: "Third" },
      V8,
      true,
    );
    expect(third?.newVariantIndex).toBe(1);
    expect(third?.section.variants?.[1]).toEqual({
      rule: ALWAYS,
      value: lazy({ ...HERO, title: "Third" }),
    });
  });

  test("adding a page variant", () => {
    expect(appendPageVariantSections([HERO], [FOOTER], V8, true)).toEqual({
      sections: {
        __resolveType: "multivariate",
        variants: [
          { rule: ALWAYS, value: lazy([FOOTER]) },
          { rule: ALWAYS, value: lazy([HERO]) },
        ],
      },
      newVariantIndex: 0,
    });
  });

  test("hiding an array item", () => {
    const hidden = hideArrayItem({ label: "Promo" }, V8);
    expect(hidden).toEqual({
      __resolveType: "multivariate",
      variants: [{ value: lazy({ label: "Promo" }), rule: NEVER }],
    });
    expect(isArrayItemHidden(hidden)).toBe(true);
    expect(showArrayItem(hidden)).toEqual({ label: "Promo" });
    expect(arrayItemDisplayValue(hidden)).toEqual({ label: "Promo" });
  });

  test("field variants under multivariate", () => {
    const wrapper = wrapAsMultivariate("a.png", "multivariate", V8);
    expect(wrapper).toEqual({
      __resolveType: "multivariate",
      variants: [
        { rule: ALWAYS, value: lazy("a.png") },
        { rule: ALWAYS, value: lazy("a.png") },
      ],
    });
    expect(appendVariant(wrapper, V8, true).variants[2]?.value).toEqual(
      lazy("a.png"),
    );
    expect(flattenMultivariate(wrapper)).toBe("a.png");
    expect(extractUrl(wrapper)).toBe("a.png");
  });
});

describe("v7 writers: exactly the old output", () => {
  test("hiding a section, adding section and page variants, hiding an item", () => {
    expect(hideSection(V7_HERO, V7)).toEqual({
      __resolveType: "website/flags/multivariate/section.ts",
      variants: [
        {
          value: V7_HERO,
          rule: { __resolveType: "website/matchers/never.ts" },
        },
      ],
    } as unknown as RawSection);

    const [parsed] = parseSections([V7_HERO], {});
    expect(
      appendSectionVariant(V7_HERO, parsed!, undefined, V7)?.section,
    ).toEqual({
      __resolveType: "website/flags/multivariate/section.ts",
      variants: [
        {
          rule: { __resolveType: "website/matchers/always.ts" },
          value: V7_HERO,
        },
        {
          rule: { __resolveType: "website/matchers/always.ts" },
          value: V7_HERO,
        },
      ],
    } as unknown as RawSection);

    expect(appendPageVariantSections([V7_HERO], [], V7)?.sections).toEqual({
      __resolveType: "website/flags/multivariate.ts",
      variants: [
        {
          rule: { __resolveType: "website/matchers/always.ts" },
          value: [V7_HERO],
        },
        { rule: { __resolveType: "website/matchers/always.ts" }, value: [] },
      ],
    });

    expect(hideArrayItem("x", V7)).toEqual({
      __resolveType: "website/flags/multivariate.ts",
      variants: [
        { value: "x", rule: { __resolveType: "website/matchers/never.ts" } },
      ],
    });
  });
});

/** A v8 page whose sections are page variants, one holding section variants and a hidden section. */
function v8Page() {
  const sectionVariants = {
    __resolveType: "multivariate",
    variants: [
      { rule: NEVER, value: lazy({ ...HERO, title: "B" }) },
      { rule: ALWAYS, value: lazy({ ...HERO, title: "A" }) },
    ],
  };
  const hidden = {
    __resolveType: "multivariate",
    variants: [{ rule: NEVER, value: lazy(FOOTER) }],
  };
  return {
    __resolveType: "page",
    name: "Home",
    path: "/",
    sections: {
      __resolveType: "multivariate",
      variants: [
        { rule: NEVER, value: lazy([FOOTER]) },
        { rule: ALWAYS, value: lazy([sectionVariants, hidden]) },
      ],
    },
  };
}

describe("readers take the v8 shape", () => {
  test("page variants", () => {
    const page = v8Page();
    expect(isMultivariateArrayWrapper(page.sections, true)).toBe(true);
    expect(isSectionMultivariateWrapperValue(page.sections, true)).toBe(false);
    expect(unwrapMultivariateArrayValue(page.sections, true)).toEqual([FOOTER]);
    const decofile = { Home: page };
    expect(getPageVariantSectionsAt(decofile, "Home", 0)).toEqual([FOOTER]);
    const variants = parsePageVariants(page.sections, decofile, () => "");
    expect(variants.map((v) => v.sections.length)).toEqual([1, 2]);
  });

  test("a section with variants and a hidden section", () => {
    const [withVariants, hidden] = v8Page().sections.variants[1]!.value
      .value as RawSection[];
    const [p0, p1] = parseSections([withVariants!, hidden!], {}, true);
    expect(p0).toMatchObject({
      isMultivariate: true,
      label: "Variants of Hero",
    });
    expect(p1).toMatchObject({ isHidden: true, label: "Footer" });

    const mv = withVariants as Record<string, unknown>;
    expect(isSectionMultivariateWrapperValue(mv, true)).toBe(true);
    expect(parseSectionFlagVariants(mv, () => "").map((v) => v.value)).toEqual([
      { ...HERO, title: "B" },
      { ...HERO, title: "A" },
    ]);
    expect(flattenMultivariateSection(withVariants!, {}, mv)).toEqual({
      ...HERO,
      title: "A",
    } as RawSection);
    expect(showSection(hidden!, true)).toEqual(FOOTER);
    expect(unwrapSection(hidden!, p1!, {}, true)).toEqual({
      data: FOOTER,
      resolveType: "footer",
    });
    expect(resolveSectionPreviewContext(hidden!, true)).toEqual({
      resolveType: "footer",
      data: FOOTER,
    });
    expect(resolveSectionCandidates(withVariants!, {}, true)).toEqual(["hero"]);
    expect(resolveSectionCandidates(hidden!, {}, true)).toBeNull();
  });

  test("a saved section block with v8 variants is offered as its section", () => {
    const block = {
      __resolveType: "multivariate",
      variants: [{ rule: ALWAYS, value: lazy(HERO) }],
    };
    expect(underlyingSectionResolveType(V8, block)).toBe("hero");
  });

  test("v7's variant calendar reads v7's shapes only, as before (a v8 site gets Campaigns)", () => {
    const decofile = {
      Promo: {
        __resolveType: "multivariate",
        variants: [
          {
            rule: {
              __resolveType: "date",
              start: "2026-11-01T00:00:00Z",
              end: "2026-11-30T00:00:00Z",
            },
            value: lazy({ ...HERO, title: "Black Friday" }),
          },
          { rule: ALWAYS, value: lazy(HERO) },
        ],
      },
    };
    expect(extractScheduledVariants(decofile)).toEqual([]);
  });
});

describe("a page-variants field's section list", () => {
  const items: SchemaProperty = { type: "block-ref", anyOfRefs: [] };
  const field = (resolveType: string, value: SchemaProperty) =>
    ({
      type: "block-ref",
      anyOfRefs: [
        {
          resolveType,
          title: resolveType,
          schema: {
            type: "object",
            properties: {
              variants: {
                type: "array",
                items: { type: "object", properties: { value } },
              },
            },
          },
        },
      ],
    }) as SchemaProperty;

  test("under multivariate the list is inside the lazy block", () => {
    const v8 = field("multivariate", {
      type: "object",
      lazy: true,
      properties: { value: { type: "array", items } },
    });
    expect(isPageMultivariateSectionArrayField(v8)).toBe(true);
    expect(pageMultivariateSectionListSchema(v8)?.items).toBe(items);
  });

  test("under the v7 page flag the list is the value itself", () => {
    const v7 = field("website/flags/multivariate.ts", { type: "array", items });
    expect(pageMultivariateSectionListSchema(v7)?.items).toBe(items);
    const notAList = field("multivariate", { type: "string" });
    expect(isPageMultivariateSectionArrayField(notAList)).toBe(false);
  });
});

describe("editing keeps each block's own shape", () => {
  test("a v8 section variant stays lazy when its section is edited", () => {
    const mv = {
      __resolveType: "multivariate",
      variants: [{ rule: ALWAYS, value: lazy(HERO) }],
    };
    expect(
      updateMultivariateSectionVariantValue(mv, 0, { ...HERO, title: "New" }),
    ).toEqual({
      __resolveType: "multivariate",
      variants: [{ rule: ALWAYS, value: lazy({ ...HERO, title: "New" }) }],
    });
  });

  test("a v8 page variant stays lazy when its sections change", () => {
    const page = v8Page();
    const decofile = { Home: page };
    const pageVariants = parsePageVariants(page.sections, decofile, () => "");
    const next = buildPageDataWithSections(
      decofile,
      "Home",
      [HERO],
      0,
      pageVariants,
    );
    expect(
      (next.sections as { variants: Array<{ value: unknown }> }).variants[0]
        ?.value,
    ).toEqual(lazy([HERO]));
    expect(
      wrapMultivariateArrayValue(page.sections, [HERO], V8, true),
    ).toMatchObject({ variants: [{ value: lazy([HERO]) }, {}] });
  });

  test("dropping to one default page variant leaves the plain list", () => {
    const sections = { __resolveType: "multivariate", variants: [] };
    expect(
      buildPageSectionsFromVariants(sections, [
        { rule: ALWAYS, value: lazy([HERO]) },
      ]),
    ).toEqual([HERO]);
  });

  test("an existing v7-shaped variant on a v8 site keeps its name and plain values", () => {
    const legacy = {
      __resolveType: "website/flags/multivariate/section.ts",
      variants: [
        { rule: { __resolveType: "website/matchers/always.ts" }, value: HERO },
      ],
    } as unknown as RawSection;
    const [parsed] = parseSections([legacy], {});
    expect(parsed?.isMultivariate).toBe(true);

    const appended = appendSectionVariant(legacy, parsed!, undefined, V8, true);
    expect(appended?.section.__resolveType).toBe(
      "website/flags/multivariate/section.ts",
    );
    expect(appended?.section.variants?.[0]).toEqual({
      rule: ALWAYS,
      value: HERO,
    });

    expect(
      updateMultivariateSectionVariantValue(
        legacy as Record<string, unknown>,
        0,
        { ...HERO, title: "Edited" },
      ),
    ).toEqual({
      __resolveType: "website/flags/multivariate/section.ts",
      variants: [
        {
          rule: { __resolveType: "website/matchers/always.ts" },
          value: { ...HERO, title: "Edited" },
        },
      ],
    });

    const legacyPage = {
      __resolveType: "website/flags/multivariate.ts",
      variants: [{ rule: ALWAYS, value: [HERO] }],
    };
    expect(
      appendPageVariantSections(legacyPage, [FOOTER], V8, true)?.sections,
    ).toEqual({
      __resolveType: "website/flags/multivariate.ts",
      variants: [
        { rule: ALWAYS, value: [FOOTER] },
        { rule: ALWAYS, value: [HERO] },
      ],
    });
  });
});

describe("preview: the forced variant's path reaches the multivariate", () => {
  test("inside a lazy page variant, one value deeper", () => {
    const [forced] = buildSectionForcedVariants({
      pageKey: "Home",
      page: {
        multivariate: true,
        index: 1,
        variants: [{}, {}],
        lazyValues: true,
      },
      sectionIndex: 0,
      sectionLazy: false,
      mvObj: { variants: [{}, {}] },
      selectedVariantIndex: 0,
    });
    expect(forced).toBe("Home@sections.variants.1.value.value.0=0");

    // That path is where the multivariate is in the JSON Studio wrote.
    const node = "sections.variants.1.value.value.0"
      .split(".")
      .reduce<unknown>(
        (at, key) => (at as Record<string, unknown>)[key],
        v8Page(),
      );
    expect((node as { __resolveType: string }).__resolveType).toBe(
      "multivariate",
    );
  });

  test("a v7 page variant keeps the old path", () => {
    const [forced] = buildSectionForcedVariants({
      pageKey: "Home",
      page: { multivariate: true, index: 1, variants: [{}, {}] },
      sectionIndex: 0,
      sectionLazy: false,
      mvObj: { variants: [{}, {}] },
      selectedVariantIndex: 0,
    });
    expect(forced).toBe("Home@sections.variants.1.value.0=0");
  });
});

/**
 * What Studio writes resolves with @decocms/blocks' own resolver (its
 * conformance test builtin-03/mv-02/lazy-07: the first true variant's lazy
 * value, and only that one, runs).
 */
describe("the JSON Studio writes resolves with @decocms/blocks", () => {
  const runs: string[] = [];
  const blocks = {
    hero: ({ title }: { title?: string }) => {
      runs.push(`hero:${title}`);
      return { section: "hero", title };
    },
    footer: () => {
      runs.push("footer");
      return { section: "footer" };
    },
  };
  let revision = 0;
  const resolve = async (target: unknown) => {
    const cms = createCMS({
      blocks,
      content: { revision: `studio-v8-variants-${++revision}`, blocks: {} },
    });
    const [value, error] = await cms.forRelease().resolve(target);
    expect(error).toBeNull();
    return value;
  };

  test("a hidden section renders nothing and never runs", async () => {
    runs.length = 0;
    expect(await resolve(hideSection(HERO, V8))).toBeUndefined();
    expect(runs).toEqual([]);
  });

  test("section variants: the first true rule's section, only it runs", async () => {
    runs.length = 0;
    const [parsed] = parseSections([HERO], {});
    const appended = appendSectionVariant(HERO, parsed!, undefined, V8, true)!;
    const mv = appended.section as unknown as {
      variants: Array<{ rule: unknown; value: unknown }>;
    };
    mv.variants[0]!.rule = NEVER;
    mv.variants[1]!.value = lazy({ ...HERO, title: "B" });
    expect(await resolve(mv)).toEqual({ section: "hero", title: "B" });
    expect(runs).toEqual(["hero:B"]);
  });

  test("page variants resolve to the picked section list", async () => {
    runs.length = 0;
    const page = v8Page();
    expect(await resolve(page.sections)).toEqual([
      { section: "hero", title: "A" },
      undefined,
    ]);
    expect(runs).toEqual(["hero:A"]);
  });

  test("a hidden array item resolves to nothing", async () => {
    expect(
      await resolve(hideArrayItem({ label: "Promo" }, V8)),
    ).toBeUndefined();
  });
});

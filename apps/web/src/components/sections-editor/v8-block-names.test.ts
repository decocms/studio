import { describe, expect, test } from "bun:test";
import { findBlogPageSlug } from "../sandbox/content/blog/blog-preview-url";
import { resolveSectionCandidates } from "../sandbox/preview/section-candidates";
import {
  hideArrayItem,
  isArrayItemHidden,
  showArrayItem,
} from "./array-item-hidden";
import { wrapAsMultivariate, appendVariant } from "./fields/media-variants";
import { extractPages } from "./page-list";
import { isPageResolveType } from "./page-types";
import {
  appendPageVariantSections,
  wrapMultivariateArrayValue,
} from "./page-variants";
import { parseSections } from "./parse-sections";
import type { LiveMeta } from "./resolve-schema";
import { getSeoFormMode, filterSeoSchema } from "./seo-form-mode";
import type { SchemaProperty } from "./resolve-schema";
import {
  alwaysMatcherResolveType,
  defaultVariantRule,
  isAlwaysMatcherResolveType,
  isNeverMatcherResolveType,
  neverMatcherResolveType,
  type RawSection,
} from "./section-types";
import {
  appendSectionVariant,
  hideSection,
  isDefaultVariantRule,
} from "./section-variants";
import {
  emptyPageBlock,
  schemaForNewPage,
  PageSchemaNotReadyError,
} from "./use-create-page";

/** The manifest `deco schema` writes for a next-major site (short names). */
const V8: LiveMeta = {
  blocksMajor: 8,
  manifest: {
    blocks: {
      pages: { page: {}, post: {}, "website/pages/Page.tsx": {} },
      matchers: {
        always: {},
        never: {},
        campaign: {},
        "website/matchers/always.ts": {},
        "website/matchers/never.ts": {},
      },
      sections: { hero: {} },
    },
  },
  schema: {},
};

/** A v7 manifest: file names only. */
const V7: LiveMeta = {
  manifest: {
    blocks: {
      pages: { "website/pages/Page.tsx": {} },
      matchers: {
        "website/matchers/always.ts": {},
        "website/matchers/never.ts": {},
      },
      sections: { "site/sections/Hero.tsx": {} },
    },
  },
  schema: {},
};

const HERO = { __resolveType: "hero", title: "Hi" } as RawSection;

describe("always/never matcher names come from the schema", () => {
  test("next-major writes the short names, v7 and no schema the file names", () => {
    expect(alwaysMatcherResolveType(V8)).toBe("always");
    expect(neverMatcherResolveType(V8)).toBe("never");
    expect(alwaysMatcherResolveType(V7)).toBe("website/matchers/always.ts");
    expect(neverMatcherResolveType(V7)).toBe("website/matchers/never.ts");
    expect(defaultVariantRule()).toEqual({
      __resolveType: "website/matchers/always.ts",
    });
    expect(defaultVariantRule(V8)).toEqual({ __resolveType: "always" });
  });

  test("every name reads as always/never", () => {
    for (const rt of [
      "always",
      "website/matchers/always.ts",
      "$live/matchers/MatchAlways.ts",
    ]) {
      expect(isAlwaysMatcherResolveType(rt)).toBe(true);
      expect(isDefaultVariantRule({ __resolveType: rt })).toBe(true);
    }
    for (const rt of ["never", "website/matchers/never.ts"]) {
      expect(isNeverMatcherResolveType(rt)).toBe(true);
    }
    expect(isNeverMatcherResolveType("date")).toBe(false);
  });

  test("hiding a section writes `never` on next-major and parses back hidden", () => {
    const hidden = hideSection(HERO, V8);
    expect(hidden.variants?.[0]?.rule).toEqual({ __resolveType: "never" });
    expect(parseSections([hidden], {})[0]?.isHidden).toBe(true);
    expect(resolveSectionCandidates(hidden, {})).toBeNull();
    // v7 keeps its file name.
    expect(hideSection(HERO, V7).variants?.[0]?.rule).toEqual({
      __resolveType: "website/matchers/never.ts",
    });
  });

  test("hiding an array item writes `never` on next-major", () => {
    const hidden = hideArrayItem({ src: "a.png" }, V8);
    expect(hidden.variants[0]?.rule).toEqual({ __resolveType: "never" });
    expect(isArrayItemHidden(hidden)).toBe(true);
    expect(showArrayItem(hidden)).toEqual({ src: "a.png" });
    expect(hideArrayItem({}, V7).variants[0]?.rule).toEqual({
      __resolveType: "website/matchers/never.ts",
    });
  });

  test("new variants get the site's always matcher", () => {
    const parsed = parseSections([HERO], {})[0]!;
    const section = appendSectionVariant(
      HERO,
      parsed,
      undefined,
      V8,
      true,
    )?.section;
    const rules = (section?.variants ?? []).map((v) => v.rule);
    expect(rules).toEqual([
      { __resolveType: "always" },
      { __resolveType: "always" },
    ]);

    const page = appendPageVariantSections([HERO], [HERO], V8, true)
      ?.sections as {
      variants: Array<{ rule: unknown }>;
    };
    expect(page.variants.map((v) => v.rule)).toEqual([
      { __resolveType: "always" },
      { __resolveType: "always" },
    ]);

    const field = wrapAsMultivariate(
      "a.png",
      "website/flags/multivariate.ts",
      V8,
    );
    expect(field.variants.map((v) => v.rule)).toEqual([
      { __resolveType: "always" },
      { __resolveType: "always" },
    ]);
    expect(appendVariant(field, V8, true).variants[2]?.rule).toEqual({
      __resolveType: "always",
    });

    const arr = wrapMultivariateArrayValue(
      { __resolveType: "website/flags/multivariate.ts", variants: [] },
      [1],
      V8,
    ) as { variants: Array<{ rule: unknown }> };
    expect(arr.variants[0]?.rule).toEqual({ __resolveType: "always" });
  });
});

describe("page types come from the schema", () => {
  test("isPageResolveType knows v7 names, `page`, and the schema's pages", () => {
    expect(isPageResolveType("website/pages/Page.tsx")).toBe(true);
    expect(isPageResolveType("$live/pages/LivePage.tsx")).toBe(true);
    expect(isPageResolveType("page")).toBe(false);
    expect(isPageResolveType("page", V8)).toBe(true);
    expect(isPageResolveType("post")).toBe(false);
    expect(isPageResolveType("post", V8)).toBe(true);
    expect(isPageResolveType("hero", V8)).toBe(false);
  });

  test("the page list includes next-major pages", () => {
    const decofile = {
      home: { __resolveType: "page", name: "Home", path: "/", sections: [] },
      hello: { __resolveType: "post", name: "Hello", path: "/blog/hello" },
    };
    expect(
      extractPages(decofile, V8)
        .map((p) => p.key)
        .sort(),
    ).toEqual(["hello", "home"]);
  });

  test("the blog post route is found on a next-major page", () => {
    const decofile = {
      "blog-post": {
        __resolveType: "page",
        name: "Blog Post",
        path: "/blog/:slug",
        sections: [{ __resolveType: "BlogPostPage" }],
      },
    };
    expect(findBlogPageSlug(decofile, V8)).toBe("/blog/:slug");
    const custom = {
      "blog-post": { ...decofile["blog-post"], __resolveType: "post" },
    };
    expect(findBlogPageSlug(custom)).toBeNull();
    expect(findBlogPageSlug(custom, V8)).toBe("/blog/:slug");
  });
});

describe("SEO form layouts on next-major", () => {
  const schema = (...keys: string[]): SchemaProperty => ({
    type: "object",
    properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
  });

  test("v7 file names keep their layouts", () => {
    expect(getSeoFormMode("website/sections/Seo/SeoV2.tsx")).toBe("general");
    expect(getSeoFormMode("commerce/sections/Seo/SeoPDPV2.tsx")).toBe("pdp");
    expect(getSeoFormMode("commerce/sections/Seo/SeoPLPV2.tsx")).toBe("plp");
    // Any other file path: the full form, even when its fields would fit.
    expect(getSeoFormMode("site/sections/MySeo.tsx", schema("title"))).toBe(
      "full",
    );
  });

  test("v8: a short name is laid out by its fields", () => {
    expect(getSeoFormMode("seo", schema("title", "description"), true)).toBe(
      "general",
    );
    expect(getSeoFormMode("productSeo", schema("title", "jsonLD"), true)).toBe(
      "pdp",
    );
    expect(
      getSeoFormMode("listingSeo", schema("title", "configJsonLD"), true),
    ).toBe("plp");
    // A field no layout has: the full form, so nothing is hidden.
    const custom = schema("title", "keywords");
    expect(getSeoFormMode("seo", custom, true)).toBe("full");
    expect(
      Object.keys(filterSeoSchema(custom, "seo", true).properties ?? {}),
    ).toEqual(["title", "keywords"]);
    // No schema: the name alone.
    expect(getSeoFormMode("productSeo", undefined, true)).toBe("pdp");
    expect(getSeoFormMode("seo", undefined, true)).toBe("full");
  });
  test("v7: a short name (a saved block) gets the full form, as before", () => {
    expect(getSeoFormMode("seo", schema("title", "description"))).toBe("full");
    expect(getSeoFormMode("productSeo", schema("title", "jsonLD"))).toBe(
      "full",
    );
    expect(getSeoFormMode("productSeo")).toBe("full");
    const general = schema("title", "description", "keywords");
    expect(
      Object.keys(filterSeoSchema(general, "seo").properties ?? {}),
    ).toEqual(["title", "description", "keywords"]);
  });
});

describe("a new page waits for the schema", () => {
  test("uses the loaded schema, else reads it, else says it isn't ready", async () => {
    expect(await schemaForNewPage(V8)).toBe(V8);
    let reads = 0;
    expect(
      await schemaForNewPage(undefined, async () => {
        reads++;
        return V8;
      }),
    ).toBe(V8);
    expect(reads).toBe(1);
    await expect(
      schemaForNewPage(null, async () => undefined),
    ).rejects.toBeInstanceOf(PageSchemaNotReadyError);
    await expect(
      schemaForNewPage(null, async () => {
        throw new Error("network");
      }),
    ).rejects.toBeInstanceOf(PageSchemaNotReadyError);
    await expect(schemaForNewPage(undefined)).rejects.toBeInstanceOf(
      PageSchemaNotReadyError,
    );
  });
});

describe("an empty new page by site generation", () => {
  test("v7: the v7 page and SEO section, with no schema read", async () => {
    expect(await emptyPageBlock("Home", "/")).toEqual({
      name: "Home",
      path: "/",
      sections: [],
      seo: { __resolveType: "website/sections/Seo/SeoV2.tsx" },
      __resolveType: "website/pages/Page.tsx",
    });
  });

  test("v8: typed from the schema, read when missing, never guessed", async () => {
    expect(
      (await emptyPageBlock("Home", "/", { meta: V8 })).__resolveType,
    ).toBe("page");
    expect(
      (
        await emptyPageBlock("Home", "/", {
          meta: null,
          loadMeta: async () => V8,
        })
      ).__resolveType,
    ).toBe("page");
    await expect(
      emptyPageBlock("Home", "/", { meta: null, loadMeta: async () => null }),
    ).rejects.toBeInstanceOf(PageSchemaNotReadyError);
  });
});

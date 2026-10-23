import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findBlogPageSlug } from "../sandbox/content/blog/blog-preview-url";
import { resolveMatcherIconName } from "./matcher-icons";
import { namedRuleSupport } from "./named-rules";
import { isPageResolveTypeOnBlocksSite } from "./page-types";
import type { LiveMeta } from "./resolve-schema";
import { blockRefLoaderConfigHasData } from "./block-ref-field-utils";
import {
  declaresBuiltInPage,
  listAvailableSections,
  listSavedSectionBlocks,
  underlyingSectionResolveType,
} from "./section-catalog";
import {
  alwaysMatcherResolveType,
  defaultVariantRule,
  neverMatcherResolveType,
} from "./section-types";
import { findSiteSeoEntry } from "./seo-block";
import {
  declaresBuiltinMultivariate,
  sectionMultivariateResolveType,
  valueMultivariateResolveType,
} from "./variant-shape";

/**
 * PO decision: everything this branch changed is a Blocks v8 site's only.
 * Each pair below is one schema-driven rule: the same manifest names, read
 * from a v8 schema (`"blocksMajor": 8`, `isV8Schema`) and from any other
 * (v7's `/live/_meta`, which never says so), where main's answer stands.
 */
const manifest = {
  blocks: {
    pages: { page: {}, post: {} },
    sections: { hero: {}, theme: {} },
    loaders: { multivariate: {}, lazy: {} },
    matchers: { always: {}, never: {}, experiment: {}, campaign: {} },
    content: { "split-traffic": {}, calendar: {} },
  },
};
const V8 = { blocksMajor: 8, manifest, schema: {} } as LiveMeta;
const NOT_V8 = { manifest, schema: {} } as LiveMeta;

describe("schema-driven names: v8 only", () => {
  test("variants, matchers and the built-in page", () => {
    expect(declaresBuiltinMultivariate(V8)).toBe(true);
    expect(declaresBuiltinMultivariate(NOT_V8)).toBe(false);
    expect(sectionMultivariateResolveType(NOT_V8)).toBe(
      "website/flags/multivariate/section.ts",
    );
    expect(valueMultivariateResolveType(NOT_V8)).toBe(
      "website/flags/multivariate.ts",
    );
    expect(alwaysMatcherResolveType(V8)).toBe("always");
    expect(alwaysMatcherResolveType(NOT_V8)).toBe("website/matchers/always.ts");
    expect(neverMatcherResolveType(NOT_V8)).toBe("website/matchers/never.ts");
    expect(defaultVariantRule(NOT_V8)).toEqual({
      __resolveType: "website/matchers/always.ts",
    });
    expect(declaresBuiltInPage(V8)).toBe(true);
    expect(declaresBuiltInPage(NOT_V8)).toBe(false);
  });

  test("A/B tests and campaigns", () => {
    expect(namedRuleSupport(V8, "experiments")).toBe("available");
    expect(namedRuleSupport(NOT_V8, "experiments")).toBe("missing");
    expect(namedRuleSupport(NOT_V8, "campaigns")).toBe("missing");
  });

  test("page types for the site SEO lookup and the blog's templates", () => {
    expect(isPageResolveTypeOnBlocksSite("post", V8)).toBe(true);
    expect(isPageResolveTypeOnBlocksSite("post", NOT_V8)).toBe(false);
    expect(
      isPageResolveTypeOnBlocksSite("website/pages/Page.tsx", NOT_V8),
    ).toBe(true);
    const blog = {
      "blog-post": {
        __resolveType: "post",
        path: "/blog/:slug",
        sections: [{ __resolveType: "BlogPostPage" }],
      },
    };
    expect(findBlogPageSlug(blog, V8)).toBe("/blog/:slug");
    expect(findBlogPageSlug(blog, NOT_V8)).toBeNull();
    // v7: a block of another page type with an `seo` is still read as the
    // site's SEO, as before; on v8 a page never is.
    const decofile = {
      home: {
        __resolveType: "post",
        seo: { __resolveType: "website/sections/Seo/SeoV2.tsx", title: "T" },
      },
    };
    expect(findSiteSeoEntry(decofile, NOT_V8)?.blockKey).toBe("home");
    expect(findSiteSeoEntry(decofile, V8)).toBeNull();
  });

  test("a short `theme` key is the theme on v8, a section like any on v7", () => {
    expect(listAvailableSections(V8).map((s) => s.resolveType)).not.toContain(
      "theme",
    );
    expect(listAvailableSections(NOT_V8).map((s) => s.resolveType)).toContain(
      "theme",
    );
    const decofile = { Theme: { __resolveType: "hero", title: "Saved" } };
    const saved = (meta: LiveMeta) =>
      listSavedSectionBlocks(meta, decofile).map((e) => e.resolveType);
    expect(saved(NOT_V8)).toContain("Theme");
  });

  test("a short `multivariate` is a variants block on v8, a saved block's key on v7", () => {
    const block = {
      __resolveType: "multivariate",
      variants: [
        { value: { __resolveType: "lazy", value: { __resolveType: "hero" } } },
      ],
    };
    expect(underlyingSectionResolveType(V8, block)).toBe("hero");
    const plain = {
      __resolveType: "multivariate",
      variants: [{ value: { __resolveType: "hero" } }],
    };
    expect(underlyingSectionResolveType(NOT_V8, plain)).toBe("multivariate");
    // An empty variants list: v8 reads it as variants with none, v7 as
    // main did (a block with a prop).
    const empty = { __resolveType: "multivariate", variants: [] };
    expect(blockRefLoaderConfigHasData(empty, undefined, true)).toBe(false);
    expect(blockRefLoaderConfigHasData(empty)).toBe(true);
  });

  test("the campaign icon", () => {
    expect(resolveMatcherIconName("campaign", undefined, true)).toBe(
      "Calendar",
    );
    expect(resolveMatcherIconName("campaign")).toBe("FilterLines");
  });

  test("the A/B test icon", () => {
    expect(resolveMatcherIconName("experiment", undefined, true)).toBe(
      "Beaker02",
    );
    expect(resolveMatcherIconName("experiment")).toBe("FilterLines");
  });
});

/**
 * The sections editor's own v8 gates, as written in it: each is the
 * content-protocol decision (`protocolProject`), false on v7 and while the
 * backend is being decided, so v7 keeps main's behaviour.
 */
describe("the sections editor's v8 gates", () => {
  const source = readFileSync(
    join(import.meta.dir, "sections-editor.tsx"),
    "utf8",
  );

  test("a variant added, duplicated or moved shows in the preview on v8 only", () => {
    // main never synced the preview on these (no syncPreview argument).
    expect(source).not.toMatch(/sectionIndex,\n\s+true,\n\s+\);/);
    expect(
      source.match(/selectedSectionIndex,\n\s+protocolProject,\n\s+\);/g),
    ).toHaveLength(2);
    expect(source).toMatch(
      /result\.newVariantIndex,\n\s+sectionIndex,\n\s+protocolProject,\n\s+\);/,
    );
  });

  test("a saved section stays on its variant on v8 only (v7 reopens on the first)", () => {
    expect(
      source.match(
        /isGlobalBlockMode && protocolProject\s+\? rootVariantFocus\s+: null/g,
      ),
    ).toHaveLength(2);
  });

  test("the SEO switch waits for the schema on v8 only", () => {
    expect(
      source.match(/seoTypesLoading=\{protocolProject && !meta\}/g),
    ).toHaveLength(2);
  });

  test("the rule picker's A/B test and Campaign items, v8 only", () => {
    expect(source).toMatch(
      /const namedRuleKinds =\n\s+protocolProject && meta && decofile/,
    );
  });
});

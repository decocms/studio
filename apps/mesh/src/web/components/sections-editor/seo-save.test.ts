import { describe, expect, test } from "bun:test";
import { buildSeoSavePayload } from "./seo-save";
import type { ResolvedSeo } from "./seo-block";

describe("buildSeoSavePayload", () => {
  test("page: merges seo into the latest page block", () => {
    const resolved: ResolvedSeo = {
      blockKey: "home",
      seoData: { title: "Old" },
      seoResolveType: "website/sections/Seo/SeoV2.tsx",
      build: () => ({}),
    };
    const latest = {
      __resolveType: "website/pages/Page.tsx",
      name: "Renamed",
      sections: ["a"],
      seo: { title: "Old" },
    };
    expect(
      buildSeoSavePayload(
        { kind: "page", pageKey: "home", pageName: "Home", path: "/" },
        resolved,
        latest,
        { title: "New" },
      ),
    ).toEqual({
      __resolveType: "website/pages/Page.tsx",
      name: "Renamed",
      sections: ["a"],
      seo: { title: "New" },
    });
  });

  test("site nested: preserves sibling fields on the config block", () => {
    const resolved: ResolvedSeo = {
      blockKey: "site",
      seoData: { title: "Old" },
      seoResolveType: "website/sections/Seo/SeoV2.tsx",
      siteKind: "nested",
      build: () => ({}),
    };
    const latest = {
      __resolveType: "site/apps/site.ts",
      theme: { color: "blue" },
      seo: { title: "Old" },
    };
    expect(
      buildSeoSavePayload({ kind: "site" }, resolved, latest, { title: "New" }),
    ).toEqual({
      __resolveType: "site/apps/site.ts",
      theme: { color: "blue" },
      seo: { title: "New" },
    });
  });

  test("site block: replaces the whole SEO block entry", () => {
    const resolved: ResolvedSeo = {
      blockKey: "seoBlock",
      seoData: { title: "Old" },
      seoResolveType: "website/sections/Seo/SeoV2.tsx",
      siteKind: "block",
      build: () => ({}),
    };
    expect(
      buildSeoSavePayload(
        { kind: "site" },
        resolved,
        { __resolveType: "website/sections/Seo/SeoV2.tsx", title: "Old" },
        { title: "Standalone" },
      ),
    ).toEqual({ title: "Standalone" });
  });
});

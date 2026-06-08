import { describe, expect, test } from "bun:test";
import { activeSeoResolveType, buildSeoSavePayload } from "./seo-save";
import type { ResolvedSeo } from "./seo-block";
import { LAZY_RENDER_RESOLVE_TYPE } from "./seo-lazy-render";

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

  test("page: preserves lazy wrapper when editing inner seo", () => {
    const resolved: ResolvedSeo = {
      blockKey: "pdp",
      seoData: { __resolveType: "commerce/sections/Seo/SeoPDPV2.tsx" },
      rawSeoData: {
        __resolveType: LAZY_RENDER_RESOLVE_TYPE,
        section: { __resolveType: "commerce/sections/Seo/SeoPDPV2.tsx" },
      },
      seoResolveType: "commerce/sections/Seo/SeoPDPV2.tsx",
      build: () => ({}),
    };
    const latest = {
      __resolveType: "website/pages/Page.tsx",
      seo: {
        __resolveType: LAZY_RENDER_RESOLVE_TYPE,
        section: {
          __resolveType: "commerce/sections/Seo/SeoPDPV2.tsx",
          title: "Old",
        },
      },
    };
    expect(
      buildSeoSavePayload(
        { kind: "page", pageKey: "pdp", pageName: "PDP", path: "/p" },
        resolved,
        latest,
        {
          __resolveType: "commerce/sections/Seo/SeoPDPV2.tsx",
          title: "New",
        },
      ),
    ).toEqual({
      __resolveType: "website/pages/Page.tsx",
      seo: {
        __resolveType: LAZY_RENDER_RESOLVE_TYPE,
        section: {
          __resolveType: "commerce/sections/Seo/SeoPDPV2.tsx",
          title: "New",
        },
      },
    });
  });

  test("page: latest seo null does not resurrect lazy rawSeoData on inner save", () => {
    const resolved: ResolvedSeo = {
      blockKey: "home",
      seoData: { title: "Old" },
      rawSeoData: {
        __resolveType: LAZY_RENDER_RESOLVE_TYPE,
        section: { title: "Old" },
      },
      seoResolveType: "website/sections/Seo/SeoV2.tsx",
      build: () => ({}),
    };
    const latest = {
      __resolveType: "website/pages/Page.tsx",
      seo: null,
    };
    expect(
      buildSeoSavePayload(
        { kind: "page", pageKey: "home", pageName: "Home", path: "/" },
        resolved,
        latest,
        { title: "Re-enabled" },
      ),
    ).toEqual({
      __resolveType: "website/pages/Page.tsx",
      seo: { title: "Re-enabled" },
    });
  });

  test("page: seo null payload disables seo", () => {
    const resolved: ResolvedSeo = {
      blockKey: "home",
      seoData: undefined,
      seoResolveType: "website/sections/Seo/SeoV2.tsx",
      build: () => ({}),
    };
    expect(
      buildSeoSavePayload(
        { kind: "page", pageKey: "home", pageName: "Home", path: "/" },
        resolved,
        { __resolveType: "website/pages/Page.tsx", seo: { title: "X" } },
        null,
      ),
    ).toEqual({
      __resolveType: "website/pages/Page.tsx",
      seo: null,
    });
  });
});

describe("activeSeoResolveType", () => {
  const resolved: ResolvedSeo = {
    blockKey: "home",
    seoData: undefined,
    seoResolveType: "website/sections/Seo/SeoV2.tsx",
    build: () => ({}),
  };

  test("uses effective __resolveType when set", () => {
    expect(
      activeSeoResolveType(
        { __resolveType: "commerce/sections/Seo/SeoPDPV2.tsx" },
        resolved,
      ),
    ).toBe("commerce/sections/Seo/SeoPDPV2.tsx");
  });

  test("falls back to resolved default when __resolveType missing", () => {
    expect(activeSeoResolveType({ title: "X" }, resolved)).toBe(
      "website/sections/Seo/SeoV2.tsx",
    );
  });
});

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SEO_RESOLVE_TYPE,
  buildSiteSeoBlockData,
  findSiteSeoEntry,
  resolveSeoTarget,
  type SiteSeoEntry,
} from "./seo-block";

describe("findSiteSeoEntry", () => {
  test("finds SEO nested on a non-page config block", () => {
    const decofile = {
      site: {
        __resolveType: "website/loaders/config.ts",
        seo: {
          __resolveType: "website/sections/Seo/SeoV2.tsx",
          title: "Home",
        },
      },
    };
    const entry = findSiteSeoEntry(decofile);
    expect(entry?.kind).toBe("nested");
    expect(entry?.blockKey).toBe("site");
    expect(entry?.seoResolveType).toBe("website/sections/Seo/SeoV2.tsx");
    expect(entry?.seoData).toEqual(decofile.site.seo);
  });

  test("recognizes nested SEO by field hints when __resolveType is absent", () => {
    const decofile = {
      config: {
        __resolveType: "website/loaders/config.ts",
        seo: { title: "Inlined", description: "no resolveType here" },
      },
    };
    const entry = findSiteSeoEntry(decofile);
    expect(entry?.kind).toBe("nested");
    // Falls back to the inferred/default resolveType for inlined props.
    expect(entry?.seoResolveType).toBe(DEFAULT_SEO_RESOLVE_TYPE);
  });

  test("without meta, inlined site seo does not scan other blocks for resolveType", () => {
    const decofile = {
      config: {
        __resolveType: "website/loaders/config.ts",
        seo: { title: "Inlined" },
      },
      somePage: {
        __resolveType: "website/pages/Page.tsx",
        seo: { __resolveType: "website/sections/Seo/SeoV3.tsx", title: "P" },
      },
    };
    const entry = findSiteSeoEntry(decofile);
    expect(entry?.seoResolveType).toBe(DEFAULT_SEO_RESOLVE_TYPE);
  });

  test("finds a standalone SEO block when no nested SEO exists", () => {
    const decofile = {
      seoBlock: {
        __resolveType: "website/sections/Seo/SeoV2.tsx",
        title: "Standalone",
      },
    };
    const entry = findSiteSeoEntry(decofile);
    expect(entry?.kind).toBe("block");
    expect(entry?.blockKey).toBe("seoBlock");
  });

  test("ignores SEO nested under a page block (not a site default)", () => {
    const decofile = {
      home: {
        __resolveType: "website/pages/Page.tsx",
        seo: { __resolveType: "website/sections/Seo/SeoV2.tsx", title: "Home" },
      },
    };
    expect(findSiteSeoEntry(decofile)).toBeNull();
  });

  test("tolerates a non-string __resolveType (not treated as a page skip)", () => {
    const decofile = {
      weird: {
        // number, not a string — must not crash or be mistaken for a page type
        __resolveType: 42 as unknown as string,
        seo: { title: "Still SEO" },
      },
    };
    const entry = findSiteSeoEntry(decofile);
    expect(entry?.kind).toBe("nested");
    expect(entry?.blockKey).toBe("weird");
  });

  test("returns null when there is no SEO anywhere", () => {
    const decofile = {
      home: { __resolveType: "website/pages/Page.tsx", sections: [] },
    };
    expect(findSiteSeoEntry(decofile)).toBeNull();
  });

  test("prefers nested site SEO over a standalone block", () => {
    const decofile = {
      standalone: {
        __resolveType: "website/sections/Seo/SeoV2.tsx",
        title: "A",
      },
      config: {
        __resolveType: "website/loaders/config.ts",
        seo: { __resolveType: "website/sections/Seo/SeoV2.tsx", title: "B" },
      },
    };
    expect(findSiteSeoEntry(decofile)?.kind).toBe("nested");
  });
});

describe("buildSiteSeoBlockData", () => {
  test("block entry: replaces the whole block with the new value", () => {
    const entry: SiteSeoEntry = {
      blockKey: "seoBlock",
      kind: "block",
      seoData: { title: "old" },
      blockData: { title: "old" },
      seoResolveType: DEFAULT_SEO_RESOLVE_TYPE,
    };
    expect(buildSiteSeoBlockData(entry, { title: "new" })).toEqual({
      title: "new",
    });
  });

  test("nested entry: preserves sibling block fields and replaces seo", () => {
    const entry: SiteSeoEntry = {
      blockKey: "config",
      kind: "nested",
      seoData: { title: "old" },
      blockData: { __resolveType: "website/loaders/config.ts", other: 1 },
      seoResolveType: DEFAULT_SEO_RESOLVE_TYPE,
    };
    expect(buildSiteSeoBlockData(entry, { title: "new" })).toEqual({
      __resolveType: "website/loaders/config.ts",
      other: 1,
      seo: { title: "new" },
    });
  });
});

describe("resolveSeoTarget", () => {
  test("page target: builds a payload that keeps page fields and nests seo", () => {
    const decofile = {
      home: {
        __resolveType: "website/pages/Page.tsx",
        sections: ["a"],
        seo: { __resolveType: "website/sections/Seo/SeoV2.tsx", title: "Home" },
      },
    };
    const resolved = resolveSeoTarget(decofile, {
      kind: "page",
      pageKey: "home",
      pageName: "Home",
      path: "/",
    });
    expect(resolved?.blockKey).toBe("home");
    expect(resolved?.seoResolveType).toBe("website/sections/Seo/SeoV2.tsx");
    expect(resolved?.build({ title: "Updated" })).toEqual({
      __resolveType: "website/pages/Page.tsx",
      sections: ["a"],
      seo: { title: "Updated" },
    });
  });

  test("page target without seo: falls back to the default resolveType", () => {
    const decofile = {
      home: { __resolveType: "website/pages/Page.tsx", sections: [] },
    };
    const resolved = resolveSeoTarget(decofile, {
      kind: "page",
      pageKey: "home",
      pageName: "Home",
      path: "/",
    });
    expect(resolved?.seoData).toBeUndefined();
    expect(resolved?.seoResolveType).toBe(DEFAULT_SEO_RESOLVE_TYPE);
  });

  test("page target whose entry is not an object resolves to null", () => {
    const decofile = { home: "not-an-object" as unknown as object };
    expect(
      resolveSeoTarget(decofile, {
        kind: "page",
        pageKey: "home",
        pageName: "Home",
        path: "/",
      }),
    ).toBeNull();
  });

  test("page target with a non-object seo treats it as no seo", () => {
    const decofile = {
      home: {
        __resolveType: "website/pages/Page.tsx",
        seo: "oops" as unknown as object,
      },
    };
    const resolved = resolveSeoTarget(decofile, {
      kind: "page",
      pageKey: "home",
      pageName: "Home",
      path: "/",
    });
    expect(resolved?.seoData).toBeUndefined();
    // The malformed seo must not be spread into the saved payload.
    expect(resolved?.build({ title: "T" })).toEqual({
      __resolveType: "website/pages/Page.tsx",
      seo: { title: "T" },
    });
  });

  test("page target for a missing key resolves to null", () => {
    expect(
      resolveSeoTarget(
        {},
        { kind: "page", pageKey: "ghost", pageName: "Ghost", path: "/x" },
      ),
    ).toBeNull();
  });

  test("site target resolves to the site SEO entry", () => {
    const decofile = {
      config: {
        __resolveType: "website/loaders/config.ts",
        seo: { __resolveType: "website/sections/Seo/SeoV2.tsx", title: "Site" },
      },
    };
    const resolved = resolveSeoTarget(decofile, { kind: "site" });
    expect(resolved?.blockKey).toBe("config");
    expect(resolved?.build({ title: "New" })).toEqual({
      __resolveType: "website/loaders/config.ts",
      seo: { title: "New" },
    });
  });

  test("site target resolves to null when no site SEO exists", () => {
    expect(resolveSeoTarget({}, { kind: "site" })).toBeNull();
  });

  test("page target uses manifest seo union when meta is provided", () => {
    const meta = {
      manifest: {
        blocks: {
          pages: {
            "website/pages/Page.tsx": { $ref: "#/definitions/Page" },
          },
          sections: {
            "website/sections/Seo/SeoPDPV2.tsx": {
              $ref: "#/definitions/SeoPDP",
            },
          },
        },
      },
      schema: {
        definitions: {
          Page: {
            type: "object",
            properties: {
              seo: {
                anyOf: [{ $ref: "#/definitions/SeoPDPSection" }],
              },
            },
          },
          SeoPDPSection: {
            allOf: [
              {
                properties: {
                  __resolveType: {
                    enum: ["website/sections/Seo/SeoPDPV2.tsx"],
                  },
                },
              },
            ],
            title: "PDP",
          },
          SeoPDP: {},
        },
      },
    };
    const resolved = resolveSeoTarget(
      {
        pdp: {
          __resolveType: "website/pages/Page.tsx",
          name: "PDP",
          path: "/p",
        },
      },
      { kind: "page", pageKey: "pdp", pageName: "PDP", path: "/p" },
      meta,
    );
    expect(resolved?.seoResolveType).toBe("website/sections/Seo/SeoPDPV2.tsx");
    expect(resolved?.seoTypeOptions?.map((o) => o.resolveType)).toEqual([
      "website/sections/Seo/SeoPDPV2.tsx",
    ]);
  });
});

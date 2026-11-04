import { describe, expect, test } from "bun:test";
import { resolveSchema, type LiveMeta } from "./resolve-schema";
import {
  defaultPageSeoResolveType,
  defaultSiteSeoResolveType,
  listPageSeoTypeOptions,
  resolvePageSeoResolveType,
  resolveSiteSeoResolveType,
  resolveSeoSchemaType,
} from "./seo-schema";
import { DEFAULT_SEO_RESOLVE_TYPE, resolveSeoTarget } from "./seo-block";

function metaWithPageSeoUnion(): LiveMeta {
  return {
    manifest: {
      blocks: {
        pages: {
          "website/pages/Page.tsx": { $ref: "#/definitions/Page" },
        },
        sections: {
          "website/sections/Seo/SeoV2.tsx": {
            $ref: "#/definitions/SeoV2",
          },
          "website/sections/Seo/SeoPDPV2.tsx": {
            $ref: "#/definitions/SeoPDPV2",
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
              anyOf: [
                { $ref: "#/definitions/SeoV2Section" },
                { $ref: "#/definitions/SeoPDPV2Section" },
              ],
            },
          },
        },
        SeoV2Section: {
          allOf: [
            {
              properties: {
                __resolveType: {
                  enum: ["website/sections/Seo/SeoV2.tsx"],
                },
              },
            },
          ],
          title: "General pages",
        },
        SeoPDPV2Section: {
          allOf: [
            {
              properties: {
                __resolveType: {
                  enum: ["website/sections/Seo/SeoPDPV2.tsx"],
                },
              },
            },
          ],
          title: "Product page",
        },
        SeoV2: { title: "Seo V2" },
        SeoPDPV2: { title: "Seo PDP V2" },
      },
    },
  };
}

describe("saved SEO form schemas", () => {
  const native = "site/sections/Seo.tsx";
  const meta: LiveMeta = {
    manifest: {
      blocks: { sections: { [native]: { $ref: "#/definitions/NativeSeo" } } },
    },
    schema: {
      definitions: {
        NativeSeo: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            canonical: { type: "string" },
            noIndexing: { type: "boolean" },
          },
        },
      },
    },
  };

  test("direct and saved SEO references expose the same native fields without flattening the value", () => {
    const seo = {
      __resolveType: "SharedSeo",
      title: "Page title",
      description: "",
    };
    const decofile = {
      BaseSeo: {
        __resolveType: native,
        title: "Base title",
        description: "Inherited copy",
        noIndexing: false,
      },
      SharedSeo: { __resolveType: "BaseSeo", title: "Shared title" },
      page: { __resolveType: "website/pages/Page.tsx", sections: [], seo },
    };
    const before = structuredClone(decofile);
    const resolved = resolveSeoTarget(
      decofile,
      { kind: "page", pageKey: "page", pageName: "Page", path: "/example" },
      meta,
    )!;
    const type = resolveSeoSchemaType(resolved.seoResolveType, decofile, meta);
    expect(type).toBe(native);
    expect(resolveSchema(type!, meta)).toEqual(resolveSchema(native, meta));
    expect(Object.keys(resolveSchema(type!, meta)!.properties!)).toEqual([
      "title",
      "description",
      "canonical",
      "noIndexing",
    ]);
    expect(resolved.build({ ...seo, title: "Edited title" })).toEqual({
      ...decofile.page,
      seo: { ...seo, title: "Edited title" },
    });
    expect(decofile).toEqual(before);
    expect(resolveSeoSchemaType(native, decofile, meta)).toBe(native);
  });

  test("cycles, missing references and malformed saved blocks do not choose an unrelated schema", () => {
    const decofile = {
      First: { __resolveType: "Second" },
      Second: { __resolveType: "First" },
      Missing: { __resolveType: "Absent" },
      Empty: {},
      Array: [],
      NonSeo: { __resolveType: "site/sections/Banner.tsx" },
    };
    for (const type of [
      "First",
      "Second",
      "Missing",
      "Empty",
      "Array",
      "Absent",
      "NonSeo",
      "toString",
      "__proto__",
    ]) {
      expect(resolveSeoSchemaType(type, decofile, meta)).toBeNull();
    }
  });

  test("bounds long alias chains", () => {
    const decofile: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++)
      decofile[`Seo${i}`] = {
        __resolveType: i === 39 ? native : `Seo${i + 1}`,
      };
    expect(resolveSeoSchemaType("Seo0", decofile, meta)).toBeNull();
    expect(resolveSeoSchemaType("Seo20", decofile, meta)).toBe(native);
  });

  test("keeps schema-declared types whose names do not follow the legacy Seo filename", () => {
    const customMeta: LiveMeta = {
      ...meta,
      manifest: {
        blocks: { sections: { metadata: { $ref: "#/definitions/NativeSeo" } } },
      },
    };
    expect(resolveSeoSchemaType("metadata", {}, customMeta)).toBe("metadata");
    expect(
      resolveSeoSchemaType(
        "Shared",
        { Shared: { __resolveType: "metadata" } },
        customMeta,
      ),
    ).toBe("metadata");
  });
});

describe("listPageSeoTypeOptions", () => {
  test("reads SEO variants from the live page schema seo anyOf", () => {
    const options = listPageSeoTypeOptions(metaWithPageSeoUnion());
    expect(options.map((o) => o.resolveType)).toEqual([
      "website/sections/Seo/SeoV2.tsx",
      "website/sections/Seo/SeoPDPV2.tsx",
    ]);
    expect(
      options.find((o) => o.resolveType === DEFAULT_SEO_RESOLVE_TYPE)?.title,
    ).toBe("General");
    expect(options[1]?.title).toBe("Product page");
  });
});

describe("resolvePageSeoResolveType", () => {
  test("uses page data __resolveType when set", () => {
    expect(
      resolvePageSeoResolveType(metaWithPageSeoUnion(), {
        __resolveType: "website/sections/Seo/SeoPDPV2.tsx",
      }),
    ).toBe("website/sections/Seo/SeoPDPV2.tsx");
  });

  test("defaults to SeoV2 when schema lists it and data has no type", () => {
    expect(
      resolvePageSeoResolveType(metaWithPageSeoUnion(), { title: "Home" }),
    ).toBe(DEFAULT_SEO_RESOLVE_TYPE);
    expect(defaultPageSeoResolveType(metaWithPageSeoUnion())).toBe(
      DEFAULT_SEO_RESOLVE_TYPE,
    );
  });
});

describe("resolveSiteSeoResolveType", () => {
  test("defaults inlined site seo using site block schema", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          apps: {
            "site/apps/site.ts": { $ref: "#/definitions/SiteApp" },
          },
          pages: {
            "website/pages/Page.tsx": { $ref: "#/definitions/Page" },
          },
          sections: {
            "website/sections/Seo/SeoV3.tsx": {
              $ref: "#/definitions/SeoV3",
            },
          },
        },
      },
      schema: {
        definitions: {
          SiteApp: {
            type: "object",
            properties: {
              seo: {
                anyOf: [{ $ref: "#/definitions/SeoV3Section" }],
              },
            },
          },
          SeoV3Section: {
            allOf: [
              {
                properties: {
                  __resolveType: {
                    enum: ["website/sections/Seo/SeoV3.tsx"],
                  },
                },
              },
            ],
            title: "Site SEO",
          },
          Page: {
            type: "object",
            properties: {
              seo: {
                anyOf: [{ $ref: "#/definitions/SeoV2Section" }],
              },
            },
          },
          SeoV2Section: {
            allOf: [
              {
                properties: {
                  __resolveType: {
                    enum: ["website/sections/Seo/SeoV2.tsx"],
                  },
                },
              },
            ],
            title: "General",
          },
          SeoV3: {},
        },
      },
    };

    expect(
      resolveSiteSeoResolveType(
        meta,
        { __resolveType: "site/apps/site.ts" },
        { title: "Store" },
      ),
    ).toBe("website/sections/Seo/SeoV3.tsx");
    expect(
      defaultSiteSeoResolveType(meta, { __resolveType: "site/apps/site.ts" }),
    ).toBe("website/sections/Seo/SeoV3.tsx");
  });
});

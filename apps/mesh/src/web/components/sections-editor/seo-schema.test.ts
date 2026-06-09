import { describe, expect, test } from "bun:test";
import type { LiveMeta } from "./resolve-schema";
import {
  defaultPageSeoResolveType,
  defaultSiteSeoResolveType,
  listPageSeoTypeOptions,
  resolvePageSeoResolveType,
  resolveSiteSeoResolveType,
} from "./seo-schema";
import { DEFAULT_SEO_RESOLVE_TYPE } from "./seo-block";

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

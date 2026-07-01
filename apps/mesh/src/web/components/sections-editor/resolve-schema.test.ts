import { describe, expect, test } from "bun:test";
import { resolveSchema, type LiveMeta } from "./resolve-schema";

function metaWithSchema(blockSchema: Record<string, unknown>): LiveMeta {
  return {
    manifest: {
      blocks: { sections: { "site/sections/Test.tsx": blockSchema } },
    },
    schema: {},
  };
}

describe("resolveSchema – nullable unions inherit leaf metadata", () => {
  test("preserves format on nullable image field (anyOf: [T, null])", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        image: {
          anyOf: [
            { type: "string", format: "image-uri", title: "Hero image" },
            { type: "null" },
          ],
        },
      },
    });

    const resolved = resolveSchema("site/sections/Test.tsx", meta);
    const image = resolved?.properties?.image;
    expect(image?.type).toBe("string");
    expect(image?.format).toBe("image-uri");
    expect(image?.title).toBe("Hero image");
  });

  test("preserves format on nullable file field", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        attachment: {
          anyOf: [{ type: "string", format: "file-uri" }, { type: "null" }],
        },
      },
    });

    const file = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.attachment;
    expect(file?.format).toBe("file-uri");
  });

  test("direct format (no union) still works", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        image: { type: "string", format: "image-uri" },
      },
    });
    expect(
      resolveSchema("site/sections/Test.tsx", meta)?.properties?.image?.format,
    ).toBe("image-uri");
  });

  test("preserves titleBy and image on array items", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        banners: {
          type: "array",
          items: {
            type: "object",
            titleBy: "{{{matcher}}}",
            title: "{{{matcher}}}",
            image: "{{{image.mobile}}}",
            properties: {
              matcher: { type: "array", items: { type: "string" } },
              image: {
                type: "object",
                properties: {
                  mobile: { type: "string", format: "image-uri" },
                  desktop: { type: "string", format: "image-uri" },
                },
              },
            },
          },
        },
      },
    });

    const banners = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.banners;
    const item = banners?.items;
    expect(item?.titleBy).toBe("{{{matcher}}}");
    expect(item?.image).toBe("{{{image.mobile}}}");
  });

  test("explicit `default: null` is preserved (nullable fields)", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        image: {
          anyOf: [{ type: "string", format: "image-uri" }, { type: "null" }],
          default: null,
        },
      },
    });
    const image = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.image;
    expect(image?.default).toBeNull();
  });

  test("preserves options on dynamic-options field", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        collection: {
          type: "string",
          format: "dynamic-options",
          options: "vtex/loaders/collections/list.ts",
        },
      },
    });

    const collection = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.collection;
    expect(collection?.format).toBe("dynamic-options");
    expect(collection?.options).toBe("vtex/loaders/collections/list.ts");
  });

  test("preserves options through nullable union", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        collection: {
          anyOf: [
            {
              type: "string",
              format: "dynamic-options",
              options: "vtex/loaders/collections/list.ts",
            },
            { type: "null" },
          ],
        },
      },
    });

    const collection = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.collection;
    expect(collection?.format).toBe("dynamic-options");
    expect(collection?.options).toBe("vtex/loaders/collections/list.ts");
  });
});

describe("resolveSchema – app resolveType aliases", () => {
  test("resolves site/apps blocks from legacy manifest keys", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          apps: {
            "deco/apps/blog.ts": { $ref: "#/definitions/BlogApp" },
          },
        },
      },
      schema: {
        definitions: {
          BlogApp: {
            type: "object",
            properties: {
              postsPerPage: { type: "number", title: "Posts per page" },
            },
          },
        },
      },
    };

    const resolved = resolveSchema("site/apps/deco/blog.ts", meta);
    expect(resolved?.properties?.postsPerPage?.title).toBe("Posts per page");
  });

  test("resolves $ref when manifest entry clobbers global definitions", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          apps: {
            "site/apps/site.ts": {
              $ref: "#/definitions/SiteApp",
              definitions: {},
            } as { $ref: string },
          },
        },
      },
      schema: {
        definitions: {
          SiteApp: {
            type: "object",
            properties: {
              siteName: { type: "string", title: "Site name" },
              seo: { type: "object", title: "SEO" },
            },
          },
        },
      },
    };

    const resolved = resolveSchema("site/apps/site.ts", meta);
    expect(resolved?.properties?.siteName?.title).toBe("Site name");
    expect(resolved?.properties?.seo?.title).toBe("SEO");
  });

  test("resolves tanstack app schemas from base64 definition keys", () => {
    const resolveType = "site/apps/local/app-tags.ts";
    const encoded = Buffer.from(resolveType).toString("base64");
    const meta: LiveMeta = {
      manifest: { blocks: {} },
      schema: {
        definitions: {
          [encoded]: {
            title: resolveType,
            type: "object",
            allOf: [
              {
                $ref: "#/definitions/AppTagsProps",
              },
            ],
            properties: {
              __resolveType: {
                type: "string",
                enum: [resolveType],
              },
            },
          },
          AppTagsProps: {
            type: "object",
            properties: {
              account: { type: "string", title: "Account Name" },
            },
          },
        },
      },
    };

    const resolved = resolveSchema(resolveType, meta);
    expect(resolved?.properties?.account?.title).toBe("Account Name");
  });

  test("merges properties from deeply nested allOf chains", () => {
    const resolveType = "site/apps/site.ts";
    const encoded = Buffer.from(resolveType).toString("base64");
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          apps: {
            [resolveType]: { $ref: `#/definitions/${encoded}` },
          },
        },
      },
      schema: {
        definitions: {
          BaseSite: {
            type: "object",
            properties: {
              global: {
                title: "Global Sections",
                type: "array",
                items: { type: "object" },
              },
              caching: { type: "object", title: "Caching configuration" },
            },
          },
          ExtensionSite: {
            type: "object",
            properties: {
              badIPS: {
                type: "array",
                title: "Bad IPS",
                items: { type: "string" },
              },
            },
          },
          Layer4: { $ref: "#/definitions/Layer3" },
          Layer3: { $ref: "#/definitions/Layer2" },
          Layer2: { $ref: "#/definitions/Layer1" },
          Layer1: { $ref: "#/definitions/Layer0" },
          Layer0: {
            allOf: [
              { $ref: "#/definitions/ExtensionSite" },
              { $ref: "#/definitions/BaseSite" },
            ],
          },
          [encoded]: {
            allOf: [{ $ref: "#/definitions/Layer4" }],
            properties: {
              __resolveType: { type: "string", enum: [resolveType] },
            },
          },
        },
      },
    };

    const resolved = resolveSchema(resolveType, meta);
    expect(resolved?.properties?.global?.title).toBe("Global Sections");
    expect(resolved?.properties?.caching?.title).toBe("Caching configuration");
    expect(resolved?.properties?.badIPS?.title).toBe("Bad IPS");
  });

  test("prefers section array over page multivariate flag for site global", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          apps: {
            "site/apps/site.ts": { $ref: "#/definitions/SiteApp" },
          },
        },
      },
      schema: {
        definitions: {
          SiteApp: {
            type: "object",
            properties: {
              global: {
                title: "Global",
                anyOf: [
                  {
                    type: "array",
                    items: {
                      anyOf: [
                        {
                          properties: {
                            __resolveType: { enum: ["Analytics"] },
                          },
                        },
                      ],
                    },
                  },
                  {
                    title: "Page Variants",
                    properties: {
                      __resolveType: {
                        enum: ["website/flags/multivariate.ts"],
                      },
                      variants: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            value: {
                              type: "array",
                              items: {
                                properties: {
                                  __resolveType: { enum: ["Analytics"] },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };

    const global = resolveSchema("site/apps/site.ts", meta)?.properties?.global;
    expect(global?.type).toBe("array");
    expect(global?.title).toBe("Global");
    expect(global?.anyOfRefs).toBeUndefined();
    expect(global?.items).toBeDefined();
  });

  test("prefers config array over product-list loaders in app flag anyOf", () => {
    const loaderRef = "#/definitions/ProductList";
    const meta: LiveMeta = {
      manifest: { blocks: {} },
      schema: {
        definitions: {
          ProductList: {
            type: "object",
            properties: {
              __resolveType: {
                enum: ["vtex/loaders/ProductList.ts"],
              },
              query: { type: "string", title: "Query" },
            },
          },
          AppProps: {
            type: "object",
            properties: {
              flags: {
                title: "Flags Personalizada",
                anyOf: [
                  { $ref: "#/definitions/Resolvable" },
                  {
                    type: "array",
                    items: {
                      type: "object",
                      title: "{{{name}}}",
                      properties: {
                        name: { type: "string", title: "Name" },
                        text: { type: "string", title: "Text" },
                      },
                    },
                  },
                  { $ref: loaderRef },
                ],
              },
            },
          },
          [Buffer.from("site/apps/local/app-tags.ts").toString("base64")]: {
            allOf: [{ $ref: "#/definitions/AppProps" }],
          },
        },
      },
    };

    const flags = resolveSchema("site/apps/local/app-tags.ts", meta)?.properties
      ?.flags;
    expect(flags?.type).toBe("array");
    expect(flags?.items?.properties?.name?.title).toBe("Name");
    expect(flags?.items?.titleBy).toBe("{{{name}}}");
    expect(flags?.anyOfRefs).toBeUndefined();
  });
});

describe("resolveSchema – type-discriminated unions", () => {
  test("CardType renders as selector instead of merged object fields", () => {
    const definitions = {
      CardType: {
        anyOf: [
          { $ref: "#/definitions/ImageCard" },
          { $ref: "#/definitions/TextCard" },
        ],
      },
      ImageCard: {
        title: "ImageCard",
        type: "object",
        properties: {
          type: { type: "string", const: "image-card", default: "image-card" },
          image: { type: "string", format: "image-uri" },
        },
      },
      TextCard: {
        title: "TextCard",
        type: "object",
        properties: {
          type: { type: "string", const: "text-card", default: "text-card" },
          line1: { type: "object", properties: { text: { type: "string" } } },
          line2: { type: "object", properties: { text: { type: "string" } } },
        },
      },
    };

    const meta: LiveMeta = {
      manifest: {
        blocks: {
          sections: {
            "site/sections/Test.tsx": {
              type: "object",
              properties: {
                cards: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      options: { $ref: "#/definitions/CardType" },
                      title: { type: "string" },
                    },
                  },
                },
              },
            } as {
              $ref?: string;
              type?: string;
              properties?: Record<string, unknown>;
            },
          },
        },
      },
      schema: { definitions },
    };

    const options = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.cards?.items?.properties?.options;

    expect(options?.type).toBe("block-ref");
    expect(options?.discriminatorKey).toBe("type");
    expect(options?.anyOfRefs?.map((ref) => ref.resolveType)).toEqual([
      "image-card",
      "text-card",
    ]);
    expect(options?.anyOfRefs?.map((ref) => ref.title)).toEqual([
      "ImageCard",
      "TextCard",
    ]);
    expect(options?.anyOfRefs?.[0]?.schema?.properties?.image).toBeDefined();
    expect(options?.anyOfRefs?.[0]?.schema?.properties?.line1).toBeUndefined();
    expect(options?.anyOfRefs?.[1]?.schema?.properties?.line1).toBeDefined();
    expect(options?.anyOfRefs?.[1]?.schema?.properties?.image).toBeUndefined();
  });

  test("CardType ref alias unwraps to type selector", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          sections: {
            "site/sections/Test.tsx": {
              type: "object",
              properties: {
                cards: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      options: {
                        $ref: "#/definitions/CardType",
                        title: "Options",
                      },
                    },
                  },
                },
              },
            } as {
              $ref?: string;
              type?: string;
              properties?: Record<string, unknown>;
            },
          },
        },
      },
      schema: {
        definitions: {
          CardType: {
            $ref: "#/definitions/ImageCard|TextCard",
            title: "CardType",
          },
          "ImageCard|TextCard": {
            anyOf: [
              { $ref: "#/definitions/ImageCard" },
              { $ref: "#/definitions/TextCard" },
            ],
          },
          ImageCard: {
            title: "ImageCard",
            type: "object",
            properties: {
              type: {
                type: "string",
                hide: "true",
                default: "image-card",
              },
              image: { type: "string", format: "image-uri" },
            },
          },
          TextCard: {
            title: "TextCard",
            type: "object",
            properties: {
              type: {
                type: "string",
                hide: "true",
                default: "text-card",
              },
              line1: {
                type: "object",
                properties: { text: { type: "string" } },
              },
            },
          },
        },
      },
    };

    const options = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.cards?.items?.properties?.options;
    expect(options?.type).toBe("block-ref");
    expect(options?.title).toBe("Options");
    expect(options?.discriminatorKey).toBe("type");
    expect(options?.anyOfRefs?.map((ref) => ref.resolveType)).toEqual([
      "image-card",
      "text-card",
    ]);
  });

  test("inline anyOf branches with type const resolve to selector", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        options: {
          anyOf: [
            {
              title: "ImageCard",
              type: "object",
              properties: {
                type: {
                  type: "string",
                  const: "image-card",
                  default: "image-card",
                },
                image: { type: "string", format: "image-uri" },
              },
            },
            {
              title: "TextCard",
              type: "object",
              properties: {
                type: {
                  type: "string",
                  const: "text-card",
                  default: "text-card",
                },
                line1: {
                  type: "object",
                  properties: { text: { type: "string" } },
                },
              },
            },
          ],
        },
      },
    });

    const options = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.options;
    expect(options?.type).toBe("block-ref");
    expect(options?.discriminatorKey).toBe("type");
    expect(options?.anyOfRefs).toHaveLength(2);
  });
});

describe("resolveSchema – plainSchema on block-ref", () => {
  test("populates plainSchema for single non-loader branch (inline anyOf)", () => {
    // When the anyOf has inline branches (not $ref), the loader detection
    // uses `a.properties.__resolveType.enum`. This mirrors the ImageWidget
    // pattern: anyOf: [{ type: "string", format: "image-uri" }, loaderDef].
    const meta = metaWithSchema({
      type: "object",
      properties: {
        image: {
          anyOf: [
            { type: "string", format: "image-uri" },
            {
              type: "object",
              properties: {
                __resolveType: {
                  type: "string",
                  enum: ["website/flags/multivariate/image.ts"],
                  default: "website/flags/multivariate/image.ts",
                },
                variants: {
                  type: "array",
                  items: { type: "object" },
                },
              },
            },
          ],
        },
      },
    });

    const image = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.image;
    expect(image?.type).toBe("block-ref");
    expect(image?.plainSchema).toBeDefined();
    expect(image?.plainSchema?.type).toBe("string");
    expect(image?.plainSchema?.format).toBe("image-uri");
  });

  test("plainSchema is undefined when all branches are loaders", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        loader: {
          anyOf: [
            {
              type: "object",
              properties: {
                __resolveType: {
                  type: "string",
                  enum: ["site/loaders/a.ts"],
                  default: "site/loaders/a.ts",
                },
              },
            },
            {
              type: "object",
              properties: {
                __resolveType: {
                  type: "string",
                  enum: ["site/loaders/b.ts"],
                  default: "site/loaders/b.ts",
                },
              },
            },
          ],
        },
      },
    });

    const loader = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.loader;
    expect(loader?.type).toBe("block-ref");
    expect(loader?.plainSchema).toBeUndefined();
  });
});

describe("resolveSchema – @hide on block-ref fields", () => {
  // Mirrors @decocms/start ≥6.10: a hidden loader/block-ref prop is emitted as
  // `{ anyOf: [Resolvable, loaderRef], hide: "true" }`. The block-ref return in
  // buildProperty must propagate `hidden: true` so the form filters it out
  // (e.g. SearchResult's `tags` / `locationUser` / `stores`).
  test("hidden block-ref prop carries hidden:true", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        tags: {
          title: "Tags",
          hide: "true",
          anyOf: [
            { $ref: "#/definitions/Resolvable" },
            { $ref: "#/definitions/SomeLoader" },
          ],
        },
        visibleField: { type: "string", title: "Visible" },
      },
    });
    (meta.schema as { definitions: Record<string, unknown> }).definitions = {
      Resolvable: {
        type: "object",
        properties: { __resolveType: { type: "string" } },
      },
      SomeLoader: {
        title: "site/loaders/some.ts",
        type: "object",
        properties: {
          __resolveType: {
            type: "string",
            enum: ["site/loaders/some.ts"],
            default: "site/loaders/some.ts",
          },
          q: { type: "string", title: "Q" },
        },
      },
    };

    const props = resolveSchema("site/sections/Test.tsx", meta)?.properties;
    expect(props?.tags?.type).toBe("block-ref");
    expect(props?.tags?.hidden).toBe(true);
    // sanity: non-hidden field stays visible
    expect(props?.visibleField?.hidden).toBeUndefined();
  });
});

describe("resolveSchema – cyclic Section-picker unions (memory blow-up guard)", () => {
  /**
   * Builds a `__SECTION_REF__`-style "pick any section" union where every
   * section carries a `menuSection: Section` field pointing back at the same
   * union. Before the cycle guard this recursed ~exponentially (depth 8 ×
   * branching 110 × cyclic re-entry) and blew up the browser (multi-GB).
   */
  function cyclicSectionMeta(sectionCount: number): LiveMeta {
    const definitions: Record<string, unknown> = {};
    const anyOf: Array<{ $ref: string }> = [];

    for (let i = 0; i < sectionCount; i++) {
      const rt = `site/sections/S${i}.tsx`;
      const wrapperKey = `W${i}`;
      const propsKey = `P${i}`;
      anyOf.push({ $ref: `#/definitions/${wrapperKey}` });
      definitions[wrapperKey] = {
        title: rt,
        allOf: [{ $ref: `#/definitions/${propsKey}` }],
        properties: { __resolveType: { type: "string", enum: [rt] } },
      };
      definitions[propsKey] = {
        type: "object",
        properties: {
          title: { type: "string", title: "Title" },
          // back-reference to the same union → cycle
          menuSection: { $ref: "#/definitions/__SECTION_REF__", title: "Menu" },
        },
      };
    }
    definitions.__SECTION_REF__ = { title: "Section", anyOf };

    return {
      manifest: {
        blocks: {
          sections: { "site/sections/S0.tsx": { $ref: "#/definitions/W0" } },
        },
      },
      schema: { definitions },
    };
  }

  test("resolves a large cyclic section union without blowing up", () => {
    const meta = cyclicSectionMeta(110);
    const start = Date.now();
    const resolved = resolveSchema("site/sections/S0.tsx", meta);
    const elapsed = Date.now() - start;

    const menu = resolved?.properties?.menuSection;
    expect(menu?.type).toBe("block-ref");
    // Option list is still emitted (selector works)…
    expect(menu?.anyOfRefs?.length).toBe(110);
    // …but oversized unions are lazy: no eager per-branch schema.
    expect(menu?.anyOfRefs?.every((r) => r.schema === undefined)).toBe(true);
    // And it completes basically instantly rather than hanging.
    expect(elapsed).toBeLessThan(1000);
  });

  test("small cyclic union still terminates and cuts the cycle", () => {
    const meta = cyclicSectionMeta(3);
    const resolved = resolveSchema("site/sections/S0.tsx", meta);

    const menu = resolved?.properties?.menuSection;
    expect(menu?.type).toBe("block-ref");
    expect(menu?.anyOfRefs?.length).toBe(3);
    // Under the eager threshold, branch schemas are materialized one level…
    const branch = menu?.anyOfRefs?.[0]?.schema;
    expect(branch?.properties?.title?.type).toBe("string");
    // …but the branch's own menuSection does NOT re-expand its options
    // (cycle guard), so recursion stays bounded.
    const nestedMenu = branch?.properties?.menuSection;
    expect(nestedMenu?.type).toBe("block-ref");
    expect(nestedMenu?.anyOfRefs?.every((r) => r.schema === undefined)).toBe(
      true,
    );
  });
});

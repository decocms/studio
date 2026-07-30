import { describe, expect, test } from "bun:test";
import {
  inferSchemaFromValue,
  isFreeformPropsSchema,
  resolveSchema,
  type LiveMeta,
} from "./resolve-schema";

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

  test("preserves format/options as siblings of a $ref (real deco shape)", () => {
    // deco emits `@format icon-select` annotations on the property node while
    // the type itself lives behind a $ref (e.g. stone ButtonCtaAttendenceProps.icon).
    const meta = metaWithSchema({
      type: "object",
      properties: {
        color: {
          $ref: "#/definitions/BackgroundColor",
          format: "icon-select",
          options: "odin-ui/loaders/background-colors.ts",
        },
      },
    });
    (meta.schema as { definitions?: Record<string, unknown> }).definitions = {
      BackgroundColor: { type: "string" },
    };

    const color = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.color;
    expect(color?.format).toBe("icon-select");
    expect(color?.options).toBe("odin-ui/loaders/background-colors.ts");
  });

  test("preserves format/options on a union of const literals", () => {
    // TS union of icon names (`"user" | "chat" | ...`) with @format icon-select:
    // the enum-from-consts path must keep the widget annotations, otherwise the
    // field demotes to a static select without icon previews.
    const meta = metaWithSchema({
      type: "object",
      properties: {
        icon: {
          anyOf: [{ const: "user" }, { const: "chat" }, { const: "earth" }],
          format: "icon-select",
          options: "site/loaders/icons.ts",
        },
      },
    });

    const icon = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.icon;
    expect(icon?.enum).toEqual(["user", "chat", "earth"]);
    expect(icon?.format).toBe("icon-select");
    expect(icon?.options).toBe("site/loaders/icons.ts");
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

  test("large type-discriminated union keeps eager branch schemas", () => {
    // Type-discriminated branches (distinguished by a `type` field, no module
    // __resolveType) have no lazy resolver, so their schemas must stay eager
    // even when the union exceeds the section-selector threshold.
    const branchCount = 50;
    const anyOf = Array.from({ length: branchCount }, (_, i) => ({
      type: "object",
      properties: {
        type: { type: "string", const: `variant-${i}` },
        label: { type: "string", title: "Label" },
      },
    }));
    const meta = metaWithSchema({
      type: "object",
      properties: { card: { anyOf } },
    });

    const card = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.card;
    expect(card?.type).toBe("block-ref");
    expect(card?.discriminatorKey).toBe("type");
    expect(card?.anyOfRefs?.length).toBe(branchCount);
    // Every branch keeps its nested fields (no lazy fallback exists).
    expect(
      card?.anyOfRefs?.every((r) => r.schema?.properties?.label !== undefined),
    ).toBe(true);
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

describe("resolveSchema – __SECTION_REF__ falls back to root.sections", () => {
  /**
   * Regression: a Section-typed prop (`children`/`fallback` on
   * NotFoundChallenge) `$ref`s `#/definitions/__SECTION_REF__`, but the meta is
   * not self-contained — the def is never materialized; the "pick any section"
   * union lives only at `schema.root.sections.anyOf`. Older/uncomposed metas
   * (raw generateMeta output, or a snapshot from a CLI version that didn't bake
   * the def) look exactly like this. Without the fallback, the field resolved to
   * an empty `object` — a blank field the user can't pick a section in, so the
   * form appears to stop after the first prop.
   */
  function sectionRefWithoutDefMeta(sectionCount: number): LiveMeta {
    const definitions: Record<string, unknown> = {
      // Real `root.sections.anyOf` always leads with the `Resolvable` fallback
      // ref — the picker must skip it (it has no `__resolveType`, so `rt`
      // degrades to the bare key with no "/"). Including it here proves the
      // exclusion runs on the fallback path, not just the `#/root/*` branch.
      Resolvable: { title: "Resolvable" },
    };
    const sectionsAnyOf: Array<{ $ref: string; inputSchema?: string }> = [
      { $ref: "#/definitions/Resolvable" },
    ];

    for (let i = 0; i < sectionCount; i++) {
      const rt = `site/sections/S${i}.tsx`;
      const wrapperKey = `W${i}`;
      const propsKey = `P${i}`;
      // The real deco shape: each entry is a `$ref` with an `inputSchema` sibling.
      sectionsAnyOf.push({
        $ref: `#/definitions/${wrapperKey}`,
        inputSchema: `#/definitions/${propsKey}`,
      });
      definitions[wrapperKey] = {
        title: rt,
        allOf: [{ $ref: `#/definitions/${propsKey}` }],
        properties: { __resolveType: { type: "string", enum: [rt] } },
      };
      definitions[propsKey] = {
        type: "object",
        properties: { title: { type: "string", title: "Title" } },
      };
    }

    // The section that hosts the two Section-typed props.
    definitions.Host = {
      type: "object",
      properties: {
        page: { type: "string", title: "Integration" },
        children: {
          $ref: "#/definitions/__SECTION_REF__",
          title: "On Product Found",
        },
        fallback: {
          $ref: "#/definitions/__SECTION_REF__",
          title: "On Product Not Found",
        },
      },
    };

    return {
      manifest: {
        blocks: {
          sections: {
            "site/sections/Host.tsx": { $ref: "#/definitions/Host" },
          },
        },
      },
      // NOTE: no `definitions.__SECTION_REF__` — only `root.sections.anyOf`.
      schema: { definitions, root: { sections: { anyOf: sectionsAnyOf } } },
    };
  }

  test("Section fields render the section picker instead of an empty object", () => {
    // 110 sections + 1 leading Resolvable entry in root.sections.anyOf.
    const meta = sectionRefWithoutDefMeta(110);
    const resolved = resolveSchema("site/sections/Host.tsx", meta);

    for (const field of ["children", "fallback"] as const) {
      const prop = resolved?.properties?.[field];
      expect(prop?.type).toBe("block-ref");
      // Every real section is offered; the Resolvable fallback ref is excluded.
      expect(prop?.anyOfRefs?.length).toBe(110);
      expect(prop?.anyOfRefs?.some((r) => r.resolveType === "Resolvable")).toBe(
        false,
      );
      // Oversized section union stays lazy — no eager per-branch schema.
      expect(prop?.anyOfRefs?.every((r) => r.schema === undefined)).toBe(true);
    }
  });

  test("small section union materializes eager branch schemas via the fallback", () => {
    // Under the eager threshold (40), the fallback path must still resolve each
    // branch's nested schema one level — mirrors the def-present small-union
    // test, but exercising the missing-def → root.sections redirect.
    const meta = sectionRefWithoutDefMeta(3);
    const children = resolveSchema("site/sections/Host.tsx", meta)?.properties
      ?.children;
    expect(children?.type).toBe("block-ref");
    expect(children?.anyOfRefs?.length).toBe(3);
    expect(children?.anyOfRefs?.[0]?.schema?.properties?.title?.type).toBe(
      "string",
    );
  });

  test("root.sections present but without anyOf resolves to empty object", () => {
    const meta = sectionRefWithoutDefMeta(3);
    // Drop the union — the registry exists but lists nothing resolvable.
    (meta.schema as { root?: { sections?: unknown } }).root = {
      sections: { title: "Section" },
    };
    const children = resolveSchema("site/sections/Host.tsx", meta)?.properties
      ?.children;
    expect(children?.type).toBe("object");
    expect(children?.anyOfRefs).toBeUndefined();
  });

  test("still resolves to empty when neither the def nor root.sections exist", () => {
    // No fallback available → the field genuinely has nothing to resolve to.
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          sections: {
            "site/sections/Host.tsx": { $ref: "#/definitions/Host" },
          },
        },
      },
      schema: {
        definitions: {
          Host: {
            type: "object",
            properties: {
              children: { $ref: "#/definitions/__SECTION_REF__" },
            },
          },
        },
      },
    };
    const children = resolveSchema("site/sections/Host.tsx", meta)?.properties
      ?.children;
    expect(children?.type).toBe("object");
    expect(children?.anyOfRefs).toBeUndefined();
  });
});

describe("resolveSchema – inline object unions (A | B) render as a choice", () => {
  // Mirrors deco's real output for `(Location | Map)[]`: an anyOf of two
  // inlined object branches with titles, no $ref / __resolveType / discriminator.
  const locationMapItems = {
    anyOf: [
      {
        type: "object",
        title: "Location",
        properties: {
          city: { type: "string", title: "City" },
          regionCode: { type: "string", title: "Region Code" },
          country: { type: "string", title: "Country" },
        },
      },
      {
        type: "object",
        title: "Map",
        properties: {
          coordinates: {
            type: "string",
            title: "Area selection",
            format: "map",
          },
        },
      },
    ],
  };

  test("Location | Map array item resolves to an inline-union", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        includeLocations: {
          type: "array",
          title: "Include Locations",
          items: locationMapItems,
        },
      },
    });
    const items = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.includeLocations?.items;
    expect(items?.type).toBe("inline-union");
    const branches = items?.inlineUnionBranches ?? [];
    expect(branches.map((b) => b.title)).toEqual(["Location", "Map"]);
    // Map branch keeps its property-level @format (deco drops object-level ones).
    expect(branches[1]?.schema?.properties?.coordinates?.format).toBe("map");
    // No const discriminators on either branch.
    expect(branches[0]?.discriminators).toBeUndefined();
  });

  test("const-tagged union (name: max-age | stale-while-revalidate) keeps discriminators", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        directive: {
          anyOf: [
            {
              type: "object",
              title: "MaxAge",
              properties: {
                name: { type: "string", const: "max-age" },
                value: { type: "number" },
              },
            },
            {
              type: "object",
              title: "StaleWhileRevalidate",
              properties: {
                name: { type: "string", const: "stale-while-revalidate" },
                value: { type: "number" },
              },
            },
          ],
        },
      },
    });
    const directive = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.directive;
    expect(directive?.type).toBe("inline-union");
    const branches = directive?.inlineUnionBranches ?? [];
    expect(branches[0]?.discriminators).toEqual({ name: "max-age" });
    expect(branches[1]?.discriminators).toEqual({
      name: "stale-while-revalidate",
    });
  });

  test("type-discriminated unions still take the block-ref path (unchanged)", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        card: {
          anyOf: [
            {
              type: "object",
              title: "ImageCard",
              properties: { type: { type: "string", const: "image" } },
            },
            {
              type: "object",
              title: "TextCard",
              properties: { type: { type: "string", const: "text" } },
            },
          ],
        },
      },
    });
    const card = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.card;
    expect(card?.type).toBe("block-ref");
    expect(card?.discriminatorKey).toBe("type");
  });
});

describe("resolveSchema – inline object unions behind $refs (real deco shape)", () => {
  // deco emits data unions like `(Location | Map)[]` as an anyOf of *$refs* to
  // bare object defs (no `__resolveType`, no saved-block title, no `type`
  // discriminator) — NOT as inlined object branches. Before the fix these fell
  // into the block-ref path, found no resolveType on either branch, dropped both,
  // and returned an empty block-ref that rendered as `[object Object]`.
  // deco base64-encodes def keys (they embed a jsdelivr URL), so real refs are
  // slash-free single-segment keys. Mirror that with plain keys here.
  function locationMatcherMeta(): LiveMeta {
    return {
      manifest: {
        blocks: {
          matchers: {
            "website/matchers/location.ts": {
              $ref: "#/definitions/LocationMatcher",
              namespace: "website",
            },
          },
        },
      },
      schema: {
        definitions: {
          LocationMatcher: {
            title: "Location",
            type: "object",
            allOf: [{ $ref: "#/definitions/LocationProps" }],
            required: ["__resolveType"],
            properties: {
              __resolveType: {
                type: "string",
                enum: ["website/matchers/location.ts"],
                default: "website/matchers/location.ts",
              },
            },
          },
          LocationProps: {
            type: "object",
            properties: {
              includeLocations: {
                $ref: "#/definitions/LocationMapArray",
                title: "Include Locations",
              },
            },
          },
          LocationMapArray: {
            type: "array",
            items: { $ref: "#/definitions/LocationMapUnion" },
            title: "[Location|Map]",
          },
          LocationMapUnion: {
            anyOf: [
              { $ref: "#/definitions/LocationBranch" },
              { $ref: "#/definitions/MapBranch" },
            ],
            title: "Location|Map",
          },
          LocationBranch: {
            type: "object",
            title: "Location",
            properties: {
              city: { type: ["string", "null"], title: "City" },
              regionCode: { type: ["string", "null"], title: "Region Code" },
              country: { type: ["string", "null"], title: "Country" },
            },
          },
          MapBranch: {
            type: "object",
            title: "Map",
            properties: {
              coordinates: {
                $ref: "#/definitions/MapWidget",
                title: "Area selection",
              },
            },
          },
          MapWidget: { type: "string", format: "map", title: "MapWidget" },
        },
      },
    };
  }

  test("(Location | Map)[] with $ref branches resolves to an inline-union", () => {
    const items = resolveSchema(
      "website/matchers/location.ts",
      locationMatcherMeta(),
    )?.properties?.includeLocations?.items;
    expect(items?.type).toBe("inline-union");
    const branches = items?.inlineUnionBranches ?? [];
    expect(branches.map((b) => b.title)).toEqual(["Location", "Map"]);
    // Location branch keeps its {city, regionCode, country} fields.
    expect(Object.keys(branches[0]?.schema?.properties ?? {}).sort()).toEqual([
      "city",
      "country",
      "regionCode",
    ]);
    // Map branch keeps its coordinates @format map (deref'd through MapWidget).
    expect(branches[1]?.schema?.properties?.coordinates?.format).toBe("map");
    // Plain data branches carry no const discriminators.
    expect(branches[0]?.discriminators).toBeUndefined();
    expect(branches[1]?.discriminators).toBeUndefined();
  });
});

describe("resolveSchema – inline-union negative cases (paths left untouched)", () => {
  test("mixed primitive|object union does NOT become inline-union", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        value: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              title: "Obj",
              properties: { x: { type: "number" } },
            },
          ],
        },
      },
    });
    const value = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.value;
    expect(value?.type).not.toBe("inline-union");
  });

  test("single-element enum acts as a const discriminator", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        directive: {
          anyOf: [
            {
              type: "object",
              title: "MaxAge",
              properties: {
                name: { type: "string", enum: ["max-age"] },
                value: { type: "number" },
              },
            },
            {
              type: "object",
              title: "NoStore",
              properties: { name: { type: "string", enum: ["no-store"] } },
            },
          ],
        },
      },
    });
    const directive = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.directive;
    expect(directive?.type).toBe("inline-union");
    expect(directive?.inlineUnionBranches?.[0]?.discriminators).toEqual({
      name: "max-age",
    });
  });
});

describe("resolveSchema – allOf is an intersection, never an inline-union", () => {
  test("allOf of inline objects merges (does NOT become a selector)", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        combined: {
          allOf: [
            { type: "object", properties: { a: { type: "string" } } },
            { type: "object", properties: { b: { type: "string" } } },
          ],
        },
      },
    });
    const combined = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.combined;
    expect(combined?.type).not.toBe("inline-union");
    // merged object exposes both branches' fields
    expect(combined?.properties?.a).toBeDefined();
    expect(combined?.properties?.b).toBeDefined();
  });

  test("boolean const works as a discriminator", () => {
    const meta = metaWithSchema({
      type: "object",
      properties: {
        toggle: {
          anyOf: [
            {
              type: "object",
              title: "On",
              properties: {
                enabled: { const: true },
                value: { type: "string" },
              },
            },
            {
              type: "object",
              title: "Off",
              properties: { enabled: { const: false } },
            },
          ],
        },
      },
    });
    const toggle = resolveSchema("site/sections/Test.tsx", meta)?.properties
      ?.toggle;
    expect(toggle?.type).toBe("inline-union");
    expect(toggle?.inlineUnionBranches?.[0]?.discriminators).toEqual({
      enabled: true,
    });
  });
});

describe("resolveSchema – #/root block-registry refs (recursive matchers)", () => {
  // Mirrors the /live/_meta shape for the Multi matcher: its `matchers: Matcher[]`
  // field chains $ref → [Matcher] → Matcher → matchers → #/root/matchers, the
  // union of every matcher implementation plus saved matcher blocks. Before the
  // fix, resolveRef only understood #/definitions/… so #/root/matchers resolved
  // to {} and each array item rendered as an empty object (blank "Item 1").
  function matcherMeta(): LiveMeta {
    return {
      manifest: {
        blocks: {
          matchers: {
            "website/matchers/multi.ts": { $ref: "#/definitions/MultiDef" },
          },
        },
      },
      schema: {
        definitions: {
          MultiDef: {
            title: "Multi",
            allOf: [{ $ref: "#/definitions/MultiProps" }],
            properties: {
              __resolveType: { enum: ["website/matchers/multi.ts"] },
            },
          },
          MultiProps: {
            type: "object",
            required: ["op", "matchers"],
            properties: {
              op: { type: "string" },
              matchers: { $ref: "#/definitions/MatcherArr", title: "Matchers" },
            },
          },
          MatcherArr: {
            type: "array",
            items: { $ref: "#/definitions/MatcherRef" },
            title: "[Matcher]",
          },
          MatcherRef: { $ref: "#/definitions/MatcherUnion", title: "Matcher" },
          MatcherUnion: { $ref: "#/root/matchers", title: "matchers" },
          Cookie: {
            title: "Cookie",
            properties: {
              __resolveType: { enum: ["website/matchers/cookie.ts"] },
              name: { type: "string", title: "Name" },
            },
          },
          Resolvable: {},
        },
        root: {
          matchers: {
            title: "matchers",
            anyOf: [
              // fallback saved-block ref, carries no __resolveType — skipped
              { $ref: "#/definitions/Resolvable" },
              // built-in module matcher, referenced by $ref
              { $ref: "#/definitions/Cookie" },
              // recursion: Multi can nest itself — must not loop forever
              { $ref: "#/definitions/MultiDef" },
              // saved matcher block, inlined with a __resolveType enum
              {
                title: "#website/matchers/device.ts@Desktop",
                properties: { __resolveType: { enum: ["Desktop"] } },
              },
            ],
          },
        },
      },
    };
  }

  test("resolves the nested Matcher array item into a block-ref picker", () => {
    const items = resolveSchema("website/matchers/multi.ts", matcherMeta())
      ?.properties?.matchers?.items;

    expect(items?.type).toBe("block-ref");
    const rts = items?.anyOfRefs?.map((r) => r.resolveType) ?? [];
    // inline saved block + built-in module matcher + recursive self, in one union
    expect(rts).toContain("Desktop");
    expect(rts).toContain("website/matchers/cookie.ts");
    expect(rts).toContain("website/matchers/multi.ts");
    // the bare Resolvable fallback (no __resolveType) is not offered as an option
    expect(rts).not.toContain("Resolvable");
  });

  test("Resolvable placeholder ($ref branch with no __resolveType enum) is excluded from the picker", () => {
    // deco-start emits root.matchers as all-$ref branches: Resolvable first,
    // then concrete matchers. Resolvable has no __resolveType.enum so its `rt`
    // falls back to the bare ref key ("Resolvable", no "/") — it must be skipped.
    const it = resolveSchema("website/matchers/multi.ts", matcherMeta())
      ?.properties?.matchers?.items;
    const rts = it?.anyOfRefs?.map((r) => r.resolveType) ?? [];
    expect(rts).not.toContain("Resolvable");
    expect(rts.length).toBeGreaterThan(0);
  });

  test("without #/root handling the item would resolve empty (regression guard)", () => {
    // A #/root ref that does not exist must degrade to {} (empty object), never
    // throw — matching the old missing-key behavior for unknown registries.
    const meta = matcherMeta();
    (meta.schema.root as Record<string, unknown>).matchers = {
      $ref: "#/root/doesNotExist",
      title: "matchers",
    };
    const items = resolveSchema("website/matchers/multi.ts", meta)?.properties
      ?.matchers?.items;
    expect(items?.type).toBe("object");
    expect(items?.anyOfRefs ?? []).toHaveLength(0);
  });
});

describe("isFreeformPropsSchema – tanstack commerce stub detection", () => {
  const VTEX_PDP = "vtex/loaders/intelligentSearch/productDetailsPage.ts";
  const meta: LiveMeta = {
    manifest: {
      blocks: {
        loaders: {
          [VTEX_PDP]: { $ref: "#/definitions/VtexStub" },
          "vtex/loaders/openApi.ts": { $ref: "#/definitions/OpenStub" },
          "site/loaders/CheckStock.ts": { $ref: "#/definitions/CheckStock" },
          "site/loaders/denoNoProps.ts": { $ref: "#/definitions/DenoNoProps" },
        },
      },
    },
    schema: {
      definitions: {
        // The shape tanstack's composeMeta actually emits for commerce/vtex
        // stubs: `additionalProperties` is dropped, only the self-referential
        // __resolveType enum survives.
        VtexStub: {
          title: VTEX_PDP,
          type: "object",
          required: ["__resolveType"],
          properties: {
            __resolveType: {
              type: "string",
              enum: [VTEX_PDP],
              default: VTEX_PDP,
            },
          },
        },
        // Future-proofing: a stub that keeps `additionalProperties: true`.
        OpenStub: {
          type: "object",
          additionalProperties: true,
          properties: { __resolveType: { type: "string" } },
        },
        CheckStock: {
          type: "object",
          properties: {
            __resolveType: {
              type: "string",
              enum: ["site/loaders/CheckStock.ts"],
            },
            ids: { type: "array", items: { type: "string" } },
          },
        },
        // Deno-style propless def: no __resolveType embedded in props.
        DenoNoProps: { type: "object" },
      },
    },
  };

  test("flags the tanstack __resolveType-only registry stub", () => {
    expect(isFreeformPropsSchema(VTEX_PDP, meta)).toBe(true);
  });

  test("flags additionalProperties stubs with no declared props", () => {
    expect(isFreeformPropsSchema("vtex/loaders/openApi.ts", meta)).toBe(true);
  });

  test("a schema with real props is not freeform", () => {
    expect(isFreeformPropsSchema("site/loaders/CheckStock.ts", meta)).toBe(
      false,
    );
    // Sanity: the real schema resolves a form.
    expect(
      resolveSchema("site/loaders/CheckStock.ts", meta)?.properties?.ids?.type,
    ).toBe("array");
  });

  test("a deno-style propless def is not freeform", () => {
    expect(isFreeformPropsSchema("site/loaders/denoNoProps.ts", meta)).toBe(
      false,
    );
  });
});

describe("inferSchemaFromValue – form from saved props", () => {
  test("infers primitive, array, and nested object fields", () => {
    const schema = inferSchemaFromValue({
      __resolveType: "vtex/loaders/legacy/productListingPage.ts",
      sort: "OrderByPriceDESC",
      count: 16,
      hideUnavailable: true,
      ids: ["149524", "149525"],
      nested: { term: "gel", deep: { n: 1 } },
    });
    expect(schema?.type).toBe("object");
    const props = schema?.properties ?? {};
    // __resolveType is plumbing, never a form field.
    expect(props.__resolveType).toBeUndefined();
    expect(props.sort?.type).toBe("string");
    expect(props.count?.type).toBe("number");
    expect(props.hideUnavailable?.type).toBe("boolean");
    expect(props.ids?.type).toBe("array");
    expect(props.ids?.items?.type).toBe("string");
    expect(props.nested?.type).toBe("object");
    expect(props.nested?.properties?.term?.type).toBe("string");
    expect(props.nested?.properties?.deep?.properties?.n?.type).toBe("number");
  });

  test("null values degrade to string fields; empty value yields no schema", () => {
    expect(inferSchemaFromValue({ fq: null })?.properties?.fq?.type).toBe(
      "string",
    );
    expect(inferSchemaFromValue({})).toBeNull();
    expect(inferSchemaFromValue({ __resolveType: "x" })).toBeNull();
  });
});

describe("resolveSchema – block-config-wrapped union (matcher Props)", () => {
  // The real deco shape (verified against a live /live/_meta): @deco/deco wraps
  // the block config as
  //   { type:object, allOf:[{$ref:Props}], properties:{__resolveType}, required:[__resolveType] }
  // where `Props` is a `$ref` ALIAS ("…@Props" → "…@A|B|C") to the actual
  // `{ anyOf: [<branch $refs>] }` def. The discriminant `segment` is a string
  // `const` marked `@hide true` (emitted as the string "true"). Only the last
  // branch adds a visible `months` field.
  const rt = "vtex/matchers/userSegment.ts";
  const meta: LiveMeta = {
    manifest: {
      blocks: { matchers: { [rt]: { $ref: "#/definitions/Wrapper" } } },
    },
    schema: {
      definitions: {
        Wrapper: {
          type: "object",
          allOf: [{ $ref: "#/definitions/Props" }],
          required: ["__resolveType"],
          properties: {
            __resolveType: { type: "string", enum: [rt], default: rt },
          },
        },
        // `@Props` is a bare `$ref` alias to the union def — the layer that
        // broke the first attempt (resolving one `$ref` level stopped here).
        Props: { $ref: "#/definitions/Union", title: "…@Props" },
        Union: {
          anyOf: [
            { $ref: "#/definitions/AnonymousWithoutCart" },
            { $ref: "#/definitions/LoggedIn" },
            { $ref: "#/definitions/LoggedInWithRecentOrders" },
          ],
        },
        AnonymousWithoutCart: {
          type: "object",
          title: "Anonymous without cart",
          required: ["segment"],
          properties: {
            segment: {
              type: "string",
              const: "anonymous-without-cart",
              default: "anonymous-without-cart",
              hide: "true",
            },
          },
        },
        LoggedIn: {
          type: "object",
          title: "Logged in",
          required: ["segment"],
          properties: {
            segment: {
              type: "string",
              const: "logged-in",
              default: "logged-in",
              hide: "true",
            },
          },
        },
        LoggedInWithRecentOrders: {
          type: "object",
          title: "Logged in with recent orders",
          required: ["segment"],
          properties: {
            segment: {
              type: "string",
              const: "logged-in-with-recent-orders",
              default: "logged-in-with-recent-orders",
              hide: "true",
            },
            months: { type: "number", title: "Months", default: 3 },
          },
        },
      },
    },
  };

  test("renders a branch selector titled by each interface", () => {
    const resolved = resolveSchema(rt, meta);
    expect(resolved?.type).toBe("inline-union");
    expect(resolved?.properties).toBeUndefined();
    expect(resolved?.inlineUnionBranches?.map((b) => b.title)).toEqual([
      "Anonymous without cart",
      "Logged in",
      "Logged in with recent orders",
    ]);
  });

  test("carries __resolveType + segment as discriminators so both survive selection", () => {
    const branches = resolveSchema(rt, meta)?.inlineUnionBranches;
    expect(branches?.[0]?.discriminators).toEqual({
      segment: "anonymous-without-cart",
      __resolveType: rt,
    });
    expect(branches?.[2]?.discriminators).toEqual({
      segment: "logged-in-with-recent-orders",
      __resolveType: rt,
    });
    // `months` stays on its own branch, not merged onto every option.
    expect(branches?.[2]?.schema?.properties?.months?.type).toBe("number");
    expect(branches?.[1]?.schema?.properties?.months).toBeUndefined();
  });
});

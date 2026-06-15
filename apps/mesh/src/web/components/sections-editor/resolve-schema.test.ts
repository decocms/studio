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
            },
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

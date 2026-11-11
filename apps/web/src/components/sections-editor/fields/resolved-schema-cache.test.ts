import { describe, expect, it, test } from "bun:test";
import {
  cachedResolveSchema,
  expandRecursiveSchema,
  fillDepthCappedBranches,
} from "./resolved-schema-cache";
import type { LiveMeta, SchemaProperty } from "../resolve-schema";

describe("cachedResolveSchema", () => {
  it("shares a frozen schema, so a consumer cannot mutate it for others", () => {
    const resolveType = "site/sections/Shared.tsx";
    const meta: LiveMeta = {
      manifest: {
        blocks: { sections: { [resolveType]: { $ref: "#/definitions/S" } } },
      },
      schema: {
        definitions: {
          S: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: { type: "string", title: "Name" } },
                },
              },
            },
          },
        },
      },
    };
    const schema = cachedResolveSchema(resolveType, meta);
    expect(cachedResolveSchema(resolveType, meta)).toBe(schema);
    const name = schema?.properties?.items?.items?.properties?.name;
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(name)).toBe(true);
    expect(() => {
      (name as { title?: string }).title = "Changed";
    }).toThrow(TypeError);
  });

  it("does not leak a resolveType's schema across different meta (site) instances", () => {
    // Built-in matcher resolveTypes are identical strings across every deco
    // site — only `meta` (site A vs. site B) tells them apart.
    const resolveType = "website/matchers/MatchDevice.ts";
    const metaA: LiveMeta = {
      manifest: {
        blocks: { matchers: { [resolveType]: { $ref: "#/definitions/A" } } },
      },
      schema: {
        $defs: {
          A: {
            type: "object",
            title: "A",
            properties: { a: { type: "string" } },
          },
        },
      },
    };
    const metaB: LiveMeta = {
      manifest: {
        blocks: { matchers: { [resolveType]: { $ref: "#/definitions/B" } } },
      },
      schema: {
        $defs: {
          B: {
            type: "object",
            title: "B",
            properties: { b: { type: "number" } },
          },
        },
      },
    };

    const resultA = cachedResolveSchema(resolveType, metaA);
    const resultB = cachedResolveSchema(resolveType, metaB);

    expect(Object.keys(resultA?.properties ?? {})).toEqual(["a"]);
    expect(Object.keys(resultB?.properties ?? {})).toEqual(["b"]);
  });
});

describe("expandRecursiveSchema", () => {
  const meta: LiveMeta = {
    manifest: { blocks: {} },
    schema: {
      definitions: {
        "[Item]": { type: "array", items: { $ref: "#/definitions/Item" } },
        Item: {
          type: "object",
          title: "{{{label}}}",
          properties: {
            label: { type: "string" },
            children: { $ref: "#/definitions/[Item]" },
          },
        },
      },
    },
  };
  const cut: SchemaProperty = {
    type: "array",
    title: "Children",
    recursiveRef: "#/definitions/[Item]",
  };

  it("fills in the skipped level and keeps the field's own title", () => {
    const expanded = expandRecursiveSchema(cut, meta);
    expect(expanded.title).toBe("Children");
    expect(expanded.recursiveRef).toBeUndefined();
    expect(expanded.items?.properties?.label?.type).toBe("string");
    expect(expanded.items?.properties?.children?.recursiveRef).toBe(
      "#/definitions/[Item]",
    );
  });

  it("returns the same object on every render", () => {
    expect(expandRecursiveSchema(cut, meta)).toBe(
      expandRecursiveSchema(cut, meta),
    );
  });

  it("leaves a schema without a recursive ref untouched", () => {
    const plain: SchemaProperty = { type: "string" };
    expect(expandRecursiveSchema(plain, meta)).toBe(plain);
    expect(expandRecursiveSchema(cut, undefined)).toBe(cut);
  });
});

describe("a self-referencing menu, six levels deep (A9: main's behaviour)", () => {
  /**
   * A Header menu, `MenuItem.children: MenuItem[]`, as commerce
   * `SiteNavigationElementLeaf.children`. resolveSchema() cuts the re-entered
   * `$ref`; the form expands it one level at a time as it is opened. There is
   * no depth cap: every level renders and edits the same fields.
   */
  const meta: LiveMeta = {
    manifest: {
      blocks: {
        sections: {
          "site/sections/Header.tsx": { $ref: "#/definitions/Header" },
        },
      },
    },
    schema: {
      definitions: {
        Header: {
          type: "object",
          properties: {
            menu: { type: "array", items: { $ref: "#/definitions/MenuItem" } },
          },
        },
        MenuItem: {
          type: "object",
          title: "{{{label}}}",
          properties: {
            label: { type: "string", title: "Label" },
            href: { type: "string" },
            children: {
              type: "array",
              items: { $ref: "#/definitions/MenuItem" },
            },
          },
        },
      },
    },
  };

  /** What the form does on the way down: renderField, then ArrayField. */
  const openField = (schema: SchemaProperty | undefined) =>
    expandRecursiveSchema(schema, meta);
  const openItem = (array: SchemaProperty | undefined) =>
    expandRecursiveSchema(openField(array)?.items, meta);

  const DEPTH = 6;

  it("renders label, href and children at every level", () => {
    const root = cachedResolveSchema("site/sections/Header.tsx", meta);
    let item = openItem(root?.properties?.menu);
    for (let level = 1; level <= DEPTH; level++) {
      expect(item?.properties?.label?.type).toBe("string");
      expect(item?.properties?.label?.title).toBe("Label");
      expect(item?.properties?.href?.type).toBe("string");
      expect(item?.properties?.children?.type).toBe("array");
      item = openItem(item?.properties?.children);
    }
    expect(item?.properties?.label?.type).toBe("string");
  });

  it("edits a level-six item's fields like a top-level one", () => {
    const leaf = { label: "Leaf", href: "/leaf", children: [] };
    let value: Record<string, unknown> = leaf;
    for (let level = DEPTH - 1; level >= 1; level--) {
      value = { label: `L${level}`, href: `/l${level}`, children: [value] };
    }

    const root = cachedResolveSchema("site/sections/Header.tsx", meta);
    let item = openItem(root?.properties?.menu);
    let node: Record<string, unknown> = value;
    for (let level = 1; level < DEPTH; level++) {
      item = openItem(item?.properties?.children);
      node = (node.children as Record<string, unknown>[])[0]!;
    }
    expect(node).toBe(leaf);
    // Every stored key of the deepest item has a field to edit it in.
    for (const key of Object.keys(node)) {
      expect(item?.properties?.[key]).toBeDefined();
    }
    expect(item?.titleBy).toBe("{{{label}}}");
  });
});

describe("fillDepthCappedBranches", () => {
  const branch = (resolveType: string, schema?: SchemaProperty) => ({
    resolveType,
    title: resolveType,
    discriminatorValue: resolveType,
    schema,
  });
  const imageSchema: SchemaProperty = {
    type: "object",
    properties: { image: { type: "string", format: "image-uri" } },
  };
  const videoSchema: SchemaProperty = {
    type: "object",
    properties: { video: { type: "string", format: "video-uri" } },
  };
  const media = (withSchemas: boolean): SchemaProperty => ({
    type: "block-ref",
    discriminatorKey: "type",
    anyOfRefs: [
      branch("image", withSchemas ? imageSchema : undefined),
      branch("video", withSchemas ? videoSchema : undefined),
    ],
  });

  test("fills discriminated branches the depth cap emptied", () => {
    const capped: SchemaProperty = {
      type: "object",
      properties: { media: media(false) },
    };
    const shallow: SchemaProperty = {
      type: "object",
      properties: { media: media(true) },
    };
    const filled = fillDepthCappedBranches(capped, shallow);
    const refs = filled.properties?.media?.anyOfRefs ?? [];
    expect(refs.map((r) => r.schema)).toEqual([imageSchema, videoSchema]);
    // Same inputs, same object: the form re-renders without churn.
    expect(fillDepthCappedBranches(capped, shallow)).toBe(filled);
  });

  test("keeps what the schema already resolved", () => {
    // `Product[]` built as a loader picker in one definition and as an inline
    // list in the other: the picker stays.
    const picker: SchemaProperty = {
      type: "block-ref",
      anyOfRefs: [{ resolveType: "site/loaders/products.ts", title: "List" }],
    };
    const resolved: SchemaProperty = {
      type: "object",
      properties: { media: media(true), shelf: picker },
    };
    const other: SchemaProperty = {
      type: "object",
      properties: {
        media: media(true),
        shelf: { type: "array", items: { type: "object" } },
      },
    };
    expect(fillDepthCappedBranches(resolved, other)).toBe(resolved);
  });

  test("leaves empty branches of a module union to lazy resolution", () => {
    const moduleUnion: SchemaProperty = {
      type: "block-ref",
      anyOfRefs: [{ resolveType: "site/sections/Hero.tsx", title: "Hero" }],
    };
    const shallow: SchemaProperty = {
      type: "block-ref",
      anyOfRefs: [
        {
          resolveType: "site/sections/Hero.tsx",
          title: "Hero",
          schema: imageSchema,
        },
      ],
    };
    expect(fillDepthCappedBranches(moduleUnion, shallow)).toBe(moduleUnion);
  });

  test("without a fallback returns the schema", () => {
    const schema = media(false);
    expect(fillDepthCappedBranches(schema, undefined)).toBe(schema);
  });
});

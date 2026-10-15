import { describe, expect, it } from "bun:test";
import {
  cachedResolveSchema,
  expandRecursiveSchema,
} from "./resolved-schema-cache";
import type { LiveMeta, SchemaProperty } from "../resolve-schema";

describe("cachedResolveSchema", () => {
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

import { describe, expect, test } from "bun:test";
import { applySchemaDefaults } from "./schema-defaults";
import type { LiveMeta, SchemaProperty } from "./resolve-schema";

const schema = (
  properties: Record<string, SchemaProperty>,
): SchemaProperty => ({
  type: "object",
  properties,
});

const menuItem = schema({
  label: { type: "string" },
  display: { type: "boolean", default: true },
});

describe("applySchemaDefaults", () => {
  test("fills a missing explicit @default", () => {
    expect(
      applySchemaDefaults(
        schema({ display: { type: "boolean", default: true } }),
        { title: "Hi" },
      ),
    ).toEqual({ title: "Hi", display: true });
  });

  test('keeps explicit values, including false, "" and 0', () => {
    const value = { label: "", count: 0, on: false };
    const result = applySchemaDefaults(
      schema({
        label: { type: "string", default: "Hello" },
        count: { type: "number", default: 5 },
        on: { type: "boolean", default: true },
      }),
      value,
    );
    expect(result).toBe(value);
  });

  test("leaves props without a default, or with a null default, missing", () => {
    const value = {};
    const result = applySchemaDefaults(
      schema({
        title: { type: "string" },
        on: { type: "boolean" },
        image: { type: "string", format: "image-uri", default: null },
      }),
      value,
    );
    expect(result).toBe(value);
  });

  test("fills defaults inside existing array items", () => {
    const result = applySchemaDefaults(
      schema({ children: { type: "array", items: menuItem } }),
      {
        children: [{ label: "A" }, { label: "B", display: false }],
      },
    );
    expect(result).toEqual({
      children: [
        { label: "A", display: true },
        { label: "B", display: false },
      ],
    });
  });

  test("fills defaults in arrays nested inside array items", () => {
    const item: SchemaProperty = schema({
      display: { type: "boolean", default: true },
      children: { type: "array", items: menuItem },
    });
    const result = applySchemaDefaults(
      schema({ items: { type: "array", items: item } }),
      { items: [{ children: [{ label: "A" }] }] },
    );
    expect(result).toEqual({
      items: [{ display: true, children: [{ label: "A", display: true }] }],
    });
  });

  test("fills defaults in existing and missing nested objects", () => {
    const style = {
      type: "object",
      properties: {
        visible: { type: "boolean", default: true },
        color: { type: "string" },
      },
    } satisfies SchemaProperty;
    expect(
      applySchemaDefaults(schema({ style }), { style: { color: "red" } }),
    ).toEqual({ style: { color: "red", visible: true } });
    expect(
      applySchemaDefaults(
        schema({
          style,
          empty: { type: "object", properties: { c: { type: "string" } } },
        }),
        {},
      ),
    ).toEqual({ style: { visible: true } });
  });

  test("copies object and array defaults", () => {
    const s = schema({
      tags: { type: "array", default: ["a"] },
      size: { type: "object", default: { w: 1 } },
    });
    const result = applySchemaDefaults(s, {}) as Record<string, unknown>;
    expect(result).toEqual({ tags: ["a"], size: { w: 1 } });
    expect(result.tags).not.toBe(s.properties?.tags?.default);
    expect(result.size).not.toBe(s.properties?.size?.default);
  });

  test("fills nested blocks from their own schema, and leaves saved-block references alone", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          sections: {
            "site/sections/Banner.tsx": {
              type: "object",
              properties: { show: { type: "boolean", default: true } },
            },
          },
        },
      },
    } as unknown as LiveMeta;
    const savedRef = { __resolveType: "Banner - Home" };
    const result = applySchemaDefaults(
      schema({ sections: { type: "array", items: { type: "block-ref" } } }),
      {
        sections: [{ __resolveType: "site/sections/Banner.tsx" }, savedRef],
      },
      meta,
    ) as { sections: unknown[] };
    expect(result.sections).toEqual([
      { __resolveType: "site/sections/Banner.tsx", show: true },
      savedRef,
    ]);
    expect(result.sections[1]).toBe(savedRef);
  });

  test("fills the inline-union branch selected by its discriminators", () => {
    const union: SchemaProperty = {
      type: "inline-union",
      inlineUnionBranches: [
        {
          title: "Recent orders",
          discriminators: { type: "recent" },
          schema: schema({
            type: { type: "string" },
            months: { type: "number", default: 3 },
          }),
        },
        {
          title: "Any",
          schema: schema({ other: { type: "number", default: 1 } }),
        },
      ],
    };
    expect(applySchemaDefaults(union, { type: "recent" })).toEqual({
      type: "recent",
      months: 3,
    });
    const unmatched = { type: "unknown" };
    expect(applySchemaDefaults(union, unmatched)).toBe(unmatched);
  });

  test("leaves nested blocks alone without meta", () => {
    const value = { banner: { __resolveType: "site/sections/Banner.tsx" } };
    expect(
      applySchemaDefaults(
        schema({
          banner: {
            type: "object",
            properties: { show: { type: "boolean", default: true } },
          },
        }),
        value,
      ),
    ).toBe(value);
  });

  test("is idempotent: a filled value is returned as is", () => {
    const s = schema({
      children: { type: "array", items: menuItem },
      size: {
        type: "object",
        default: {},
        properties: { w: { type: "number", default: 1 } },
      },
    });
    const once = applySchemaDefaults(s, { children: [{}] });
    expect(once).toEqual({ children: [{ display: true }], size: { w: 1 } });
    expect(applySchemaDefaults(s, once)).toBe(once);
  });

  test("ignores __-prefixed and @type schema keys", () => {
    expect(
      applySchemaDefaults(
        schema({
          "@type": { type: "string", default: "X" },
          __hint: { type: "string", default: "Y" },
          real: { type: "string", default: "Z" },
        }),
        {},
      ),
    ).toEqual({ real: "Z" });
  });

  test("returns non-object values and schemas without properties untouched", () => {
    const s = schema({ display: { type: "boolean", default: true } });
    expect(applySchemaDefaults(s, null)).toBeNull();
    const list = [1, 2];
    expect(applySchemaDefaults(s, list)).toBe(list);
    const value = { a: 1 };
    expect(applySchemaDefaults({ type: "object" }, value)).toBe(value);
    expect(applySchemaDefaults(null, value)).toBe(value);
  });
});

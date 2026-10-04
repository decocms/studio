import { describe, expect, test } from "bun:test";
import { schemaDefaults } from "./schema-defaults";
import type { SchemaProperty } from "./resolve-schema";

const schema = (
  properties: Record<string, SchemaProperty>,
): SchemaProperty => ({
  type: "object",
  properties,
});

describe("schemaDefaults", () => {
  test("returns the explicit @default of each prop", () => {
    expect(
      schemaDefaults(
        schema({
          display: { type: "boolean", default: true },
          label: { type: "string", default: "Ver tudo" },
          count: { type: "number", default: 0 },
        }),
      ),
    ).toEqual({ display: true, label: "Ver tudo", count: 0 });
  });

  test("omits props without a default and props whose default is null", () => {
    expect(
      schemaDefaults(
        schema({
          title: { type: "string" },
          on: { type: "boolean" },
          image: { type: "string", format: "image-uri", default: null },
        }),
      ),
    ).toEqual({});
  });

  test("includes defaults of nested plain objects, and omits objects without any", () => {
    expect(
      schemaDefaults(
        schema({
          style: {
            type: "object",
            properties: {
              visible: { type: "boolean", default: true },
              color: { type: "string" },
            },
          },
          empty: {
            type: "object",
            properties: { color: { type: "string" } },
          },
        }),
      ),
    ).toEqual({ style: { visible: true } });
  });

  test("does not build array items: each item gets its defaults when added", () => {
    expect(
      schemaDefaults(
        schema({
          children: {
            type: "array",
            items: schema({ display: { type: "boolean", default: true } }),
          },
        }),
      ),
    ).toEqual({});
  });

  test("copies object and array defaults so values never share them", () => {
    const s = schema({
      tags: { type: "array", default: ["a"] },
      size: { type: "object", default: { w: 1 } },
    });
    const first = schemaDefaults(s);
    const second = schemaDefaults(s);
    expect(first).toEqual({ tags: ["a"], size: { w: 1 } });
    expect(first.tags).not.toBe(second.tags);
    expect(first.size).not.toBe(s.properties?.size?.default);
  });

  test("ignores __-prefixed and @type schema keys", () => {
    expect(
      schemaDefaults(
        schema({
          "@type": { type: "string", default: "X" },
          __hint: { type: "string", default: "Y" },
          real: { type: "string", default: "Z" },
        }),
      ),
    ).toEqual({ real: "Z" });
  });

  test("returns an empty object without a schema or properties", () => {
    expect(schemaDefaults(null)).toEqual({});
    expect(schemaDefaults({ type: "object" })).toEqual({});
  });
});

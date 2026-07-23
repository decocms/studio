import { describe, expect, test } from "bun:test";
import {
  blockRefArrayItemSchemaFromRefs,
  inferBlockRefArrayItemSchema,
} from "./block-ref-array-inference";
import type { SchemaProperty } from "./resolve-schema";

describe("inferBlockRefArrayItemSchema", () => {
  test("infers primitive props from the first element", () => {
    const items = inferBlockRefArrayItemSchema([
      { route: "/x", count: 3, flag: true, nested: {} },
    ]);
    expect(items?.type).toBe("object");
    expect(items?.properties).toEqual({
      route: { type: "string" },
      count: { type: "number" },
      flag: { type: "boolean" },
    });
    // nested objects are intentionally skipped, and the inferred schema carries
    // no titleBy — hence blockRefArrayItemSchemaFromRefs is preferred.
    expect(items?.titleBy).toBeUndefined();
  });

  test("returns undefined for an empty array", () => {
    expect(inferBlockRefArrayItemSchema([])).toBeUndefined();
  });
});

describe("blockRefArrayItemSchemaFromRefs", () => {
  // A deco loader that injects an `X[]` prop exposes the array as one of its
  // own props with the declared item schema (incl. `@title {{{route}}}`).
  const seoTextsItems: SchemaProperty = {
    type: "object",
    title: "{{{route}}}",
    titleBy: "{{{route}}}",
    properties: {
      route: { type: "string" },
      title: { type: "string" },
      text: { type: "string" },
      bottomText: { type: "string", format: "rich-text" },
    },
  };
  const blockRefSchema: SchemaProperty = {
    type: "block-ref",
    anyOfRefs: [
      { resolveType: "site/loaders/seoTexts.ts", title: "SeoTexts" },
      {
        resolveType: "site/loaders/seoTexts.ts",
        title: "SeoTexts",
        schema: {
          type: "object",
          properties: {
            seoTexts: { type: "array", items: seoTextsItems },
          },
        },
      },
    ],
  };

  test("recovers the declared item schema (with titleBy) from a loader branch", () => {
    const value = [{ route: "/eletroportateis", text: "Na Le Biscuit..." }];
    const items = blockRefArrayItemSchemaFromRefs(blockRefSchema, value);
    expect(items?.titleBy).toBe("{{{route}}}");
    expect(items?.properties?.bottomText?.format).toBe("rich-text");
  });

  test("recovers item schema from a branch that is the array itself", () => {
    const schema: SchemaProperty = {
      type: "block-ref",
      anyOfRefs: [
        {
          resolveType: "site/loaders/x.ts",
          title: "x",
          schema: { type: "array", items: seoTextsItems },
        },
      ],
    };
    const items = blockRefArrayItemSchemaFromRefs(schema, [{ route: "/a" }]);
    expect(items?.titleBy).toBe("{{{route}}}");
  });

  test("picks the array whose properties cover the data keys", () => {
    const schema: SchemaProperty = {
      type: "block-ref",
      anyOfRefs: [
        {
          resolveType: "site/loaders/multi.ts",
          title: "multi",
          schema: {
            type: "object",
            properties: {
              tags: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: { type: "string" } },
                },
              },
              seoTexts: { type: "array", items: seoTextsItems },
            },
          },
        },
      ],
    };
    const value = [{ route: "/a", text: "b" }];
    const items = blockRefArrayItemSchemaFromRefs(schema, value);
    expect(items?.titleBy).toBe("{{{route}}}");
  });

  test("returns undefined when no branch array covers the data keys", () => {
    const schema: SchemaProperty = {
      type: "block-ref",
      anyOfRefs: [
        {
          resolveType: "site/loaders/other.ts",
          title: "other",
          schema: {
            type: "object",
            properties: {
              tags: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: { type: "string" } },
                },
              },
            },
          },
        },
      ],
    };
    const value = [{ route: "/a", text: "b" }];
    expect(blockRefArrayItemSchemaFromRefs(schema, value)).toBeUndefined();
  });

  test("uses the sole candidate for an empty array value", () => {
    const items = blockRefArrayItemSchemaFromRefs(blockRefSchema, []);
    expect(items?.titleBy).toBe("{{{route}}}");
  });

  test("returns undefined when there are no anyOfRefs", () => {
    const schema: SchemaProperty = { type: "block-ref" };
    expect(
      blockRefArrayItemSchemaFromRefs(schema, [{ route: "/a" }]),
    ).toBeUndefined();
  });
});

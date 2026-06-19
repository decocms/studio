import { describe, expect, test } from "bun:test";
import { inferBlockRefArrayItemSchema } from "./block-ref-array-inference";

describe("inferBlockRefArrayItemSchema", () => {
  test("infers string, number, boolean from first item", () => {
    const items = [{ label: "Sale", count: 3, active: true }];
    const schema = inferBlockRefArrayItemSchema(items);
    expect(schema).toEqual({
      type: "object",
      properties: {
        label: { type: "string" },
        count: { type: "number" },
        active: { type: "boolean" },
      },
    });
  });

  test("skips keys starting with __", () => {
    const items = [{ __resolveType: "loader.ts", name: "Product" }];
    const schema = inferBlockRefArrayItemSchema(items);
    expect(schema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
  });

  test("returns undefined for empty array", () => {
    expect(inferBlockRefArrayItemSchema([])).toBeUndefined();
  });

  test("returns undefined when first item is null", () => {
    expect(inferBlockRefArrayItemSchema([null])).toBeUndefined();
  });

  test("returns undefined when first item is a primitive", () => {
    expect(inferBlockRefArrayItemSchema(["hello"])).toBeUndefined();
    expect(inferBlockRefArrayItemSchema([42])).toBeUndefined();
  });

  test("returns undefined when first item is a nested array", () => {
    expect(inferBlockRefArrayItemSchema([[1, 2]])).toBeUndefined();
  });

  test("skips nested objects and arrays in properties", () => {
    const items = [{ name: "A", nested: { x: 1 }, tags: ["a", "b"] }];
    const schema = inferBlockRefArrayItemSchema(items);
    expect(schema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
  });

  test("returns undefined when all keys are internal (__prefixed)", () => {
    const items = [{ __resolveType: "X", __id: "123" }];
    expect(inferBlockRefArrayItemSchema(items)).toBeUndefined();
  });
});

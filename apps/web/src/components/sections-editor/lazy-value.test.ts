import { describe, expect, test } from "bun:test";
import {
  isLazyFieldSchema,
  isLazyWrapper,
  unwrapLazy,
  wrapLazy,
} from "./lazy-value";
import { resolveSchema, type LiveMeta } from "./resolve-schema";

/** What `deco schema` writes for a `Lazy<T>` field. */
const lazySchema = (value: Record<string, unknown>) => ({
  type: "object",
  required: ["__resolveType", "value"],
  properties: {
    __resolveType: { type: "string", enum: ["lazy"], default: "lazy" },
    value,
  },
});

describe("Lazy<T> values", () => {
  test("wraps and unwraps", () => {
    expect(wrapLazy("hi")).toEqual({ __resolveType: "lazy", value: "hi" });
    expect(wrapLazy(["a"])).toEqual({ __resolveType: "lazy", value: ["a"] });
    expect(wrapLazy(undefined)).toBeUndefined();
    expect(unwrapLazy({ __resolveType: "lazy", value: 3 })).toBe(3);
    // A value that isn't wrapped (legacy content) reads as is.
    expect(unwrapLazy("plain")).toBe("plain");
    // Wrapping twice doesn't nest.
    expect(wrapLazy(wrapLazy("x"))).toEqual({
      __resolveType: "lazy",
      value: "x",
    });
  });

  test("tells the wrapper from other blocks", () => {
    expect(isLazyWrapper({ __resolveType: "lazy", value: null })).toBe(true);
    expect(isLazyWrapper({ __resolveType: "lazy" })).toBe(false);
    expect(isLazyWrapper({ __resolveType: "hero", value: 1 })).toBe(false);
    expect(isLazyWrapper([{ __resolveType: "lazy", value: 1 }])).toBe(false);
  });

  test("recognizes a resolved Lazy<T> field, including in a list", () => {
    const meta: LiveMeta = {
      manifest: {
        blocks: { sections: { shelf: { $ref: "#/definitions/c2hlbGY=" } } },
      },
      schema: {
        definitions: {
          "c2hlbGY=": {
            type: "object",
            properties: {
              __resolveType: { type: "string", enum: ["shelf"] },
              products: lazySchema({
                type: "array",
                items: { type: "string" },
              }),
              teasers: {
                type: "array",
                items: lazySchema({ type: "string" }),
              },
              title: { type: "string" },
            },
          },
        },
      },
    };
    const props = resolveSchema("shelf", meta)?.properties;
    expect(isLazyFieldSchema(props!.products!)).toBe(true);
    expect(props!.products!.properties!.value!.type).toBe("array");
    expect(isLazyFieldSchema(props!.teasers!.items!)).toBe(true);
    expect(isLazyFieldSchema(props!.title!)).toBe(false);
  });
});

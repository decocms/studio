import { describe, expect, test } from "bun:test";
import { applySchemaDefaults } from "./apply-schema-defaults";
import type { SchemaProperty } from "./resolve-schema";

const schema = (
  properties: Record<string, SchemaProperty>,
): SchemaProperty => ({
  type: "object",
  properties,
});

describe("applySchemaDefaults", () => {
  test("seeds an untouched boolean @default true into the saved value", () => {
    const result = applySchemaDefaults(
      schema({ display: { type: "boolean", default: true } }),
      { title: "Hi" },
    );
    expect(result).toEqual({ title: "Hi", display: true });
  });

  test("keeps an explicit value that equals the default absent-of-overwrite", () => {
    const value = { display: false };
    const result = applySchemaDefaults(
      schema({ display: { type: "boolean", default: true } }),
      value,
    );
    // An explicit `false` the user chose is never replaced by `default: true`.
    expect(result).toEqual({ display: false });
  });

  test('does not overwrite explicit falsy values ("", 0, false)', () => {
    const result = applySchemaDefaults(
      schema({
        label: { type: "string", default: "Hello" },
        count: { type: "number", default: 5 },
        on: { type: "boolean", default: true },
      }),
      { label: "", count: 0, on: false },
    );
    expect(result).toEqual({ label: "", count: 0, on: false });
  });

  test("does not seed props without an explicit default", () => {
    const result = applySchemaDefaults(
      schema({ title: { type: "string" }, display: { type: "boolean" } }),
      {},
    );
    expect(result).toEqual({});
  });

  test("returns the same reference when nothing changes (no-op)", () => {
    const value = { display: true };
    const result = applySchemaDefaults(
      schema({ display: { type: "boolean", default: true } }),
      value,
    );
    expect(result).toBe(value);
  });

  test("recurses into nested plain objects", () => {
    const result = applySchemaDefaults(
      schema({
        style: {
          type: "object",
          properties: { visible: { type: "boolean", default: true } },
        },
      }),
      { style: { color: "red" } },
    );
    expect(result).toEqual({ style: { color: "red", visible: true } });
  });

  test("skips __resolveType-wrapped values (multivariate/block-ref wrappers)", () => {
    const wrapped = { __resolveType: "site/loaders/x.ts", id: 1 };
    const result = applySchemaDefaults(
      schema({
        products: {
          type: "object",
          properties: { count: { type: "number", default: 12 } },
        },
      }),
      { products: wrapped },
    );
    expect(result).toEqual({ products: wrapped });
    expect((result as { products: unknown }).products).toBe(wrapped);
  });

  test("ignores __-prefixed and @type schema keys", () => {
    const result = applySchemaDefaults(
      schema({
        "@type": { type: "string", default: "X" },
        __hint: { type: "string", default: "Y" },
        real: { type: "string", default: "Z" },
      }),
      {},
    );
    expect(result).toEqual({ real: "Z" });
  });

  test("leaves non-object values untouched", () => {
    const s = schema({ display: { type: "boolean", default: true } });
    expect(applySchemaDefaults(s, null)).toBeNull();
    expect(applySchemaDefaults(s, [1, 2])).toEqual([1, 2]);
    expect(applySchemaDefaults(s, "str")).toBe("str");
  });

  test("returns the value unchanged when schema has no properties", () => {
    const value = { a: 1 };
    expect(applySchemaDefaults({ type: "object" }, value)).toBe(value);
    expect(applySchemaDefaults(null, value)).toBe(value);
  });
});

import { describe, expect, test } from "bun:test";
import { inferBlockRefArrayItemSchema } from "./block-ref-array-inference";
import { renderField, SchemaForm } from "./schema-form";
import { ObjectField } from "./fields/object-field";
import { AnyOfField } from "./fields/any-of-field";
import { BooleanField } from "./fields/boolean-field";
import { NumberField } from "./fields/number-field";
import { StringField } from "./fields/string-field";
import type { LiveMeta } from "./resolve-schema";

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

describe("renderField – collapsed loader-ref value routing", () => {
  const LOADER = "site/loaders/BuyTogether.ts";
  const loaderMeta: LiveMeta = {
    manifest: {
      blocks: {
        loaders: { [LOADER]: { $ref: "#/definitions/BuyTogetherProps" } },
      },
    },
    schema: {
      definitions: {
        BuyTogetherProps: {
          type: "object",
          properties: { rules: { type: "array", items: { type: "string" } } },
        },
      },
    },
  };
  const loaderValue = { __resolveType: LOADER, rules: [] as string[] };
  const baseProps = {
    onChange: () => {},
    path: "buyTogether",
    label: "Buy Together",
  };
  const typeOf = (el: unknown) => (el as { type?: unknown } | null)?.type;

  // Regression: collapsed-array schema + loader-ref value used to route to ObjectField (null).
  test("collapsed loader-ref value renders the referenced block form", () => {
    const el = renderField({
      ...baseProps,
      schema: { type: "array" },
      value: loaderValue,
      meta: loaderMeta,
    });
    expect(el).not.toBeNull();
    expect(typeOf(el)).toBe(SchemaForm);
  });

  // Boundary: unresolvable ref (no meta) must fall through to the old object path.
  test("falls through to ObjectField when the ref can't be resolved", () => {
    const el = renderField({
      ...baseProps,
      schema: { type: "array" },
      value: loaderValue,
    });
    expect(typeOf(el)).not.toBe(SchemaForm);
    expect(typeOf(el)).toBe(ObjectField);
  });

  // Ordering guard: a schema that kept its picker branch must still render AnyOfField.
  test("block-ref schema with anyOfRefs still renders the picker", () => {
    const el = renderField({
      ...baseProps,
      schema: {
        type: "block-ref",
        anyOfRefs: [{ resolveType: LOADER, title: "Buy Together" }],
      },
      value: { __resolveType: LOADER },
      meta: loaderMeta,
    });
    expect(typeOf(el)).toBe(AnyOfField);
  });
});

describe("renderField – boolean schema wins over stored value type", () => {
  const typeOf = (el: unknown) => (el as { type?: unknown } | null)?.type;
  const baseProps = {
    onChange: () => {},
    path: "noIndexing",
    label: "No Indexing",
  };

  // Regression: a boolean flag mis-seeded with `""` used to render a text input.
  test("boolean schema with a string value renders a switch", () => {
    const el = renderField({
      ...baseProps,
      schema: { type: "boolean" },
      value: "",
    });
    expect(typeOf(el)).toBe(BooleanField);
  });

  test("boolean schema with a boolean value renders a switch", () => {
    const el = renderField({
      ...baseProps,
      schema: { type: "boolean" },
      value: true,
    });
    expect(typeOf(el)).toBe(BooleanField);
  });

  test("string schema still renders a text input", () => {
    const el = renderField({
      ...baseProps,
      path: "title",
      schema: { type: "string" },
      value: "hello",
    });
    expect(typeOf(el)).toBe(StringField);
  });

  // Same regression class: a number/integer flag mis-seeded with `""` used to render a text input.
  test("number schema with a string value renders a number input", () => {
    const el = renderField({
      ...baseProps,
      path: "priority",
      schema: { type: "number" },
      value: "",
    });
    expect(typeOf(el)).toBe(NumberField);
  });

  test("integer schema with a string value renders a number input", () => {
    const el = renderField({
      ...baseProps,
      path: "priority",
      schema: { type: "integer" },
      value: "",
    });
    expect(typeOf(el)).toBe(NumberField);
  });

  // Same regression class: an object field mis-seeded with `""` used to vanish from the form.
  test("object schema with a string value renders as an object, not dropped", () => {
    const el = renderField({
      ...baseProps,
      path: "seo",
      schema: { type: "object", properties: {} },
      value: "",
    });
    expect(typeOf(el)).toBe(ObjectField);
  });
});

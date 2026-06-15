import { describe, expect, test } from "bun:test";
import type { SchemaProperty } from "./resolve-schema";
import {
  fieldDisplayLabel,
  isArrayDrillDownField,
  resolveActiveFieldKey,
  resolveArrayItemSelection,
} from "./schema-form-breadcrumb";
import { PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE } from "./section-types";

describe("fieldDisplayLabel", () => {
  test("prefers schema title", () => {
    expect(
      fieldDisplayLabel("cards", { title: "Cards" } as SchemaProperty),
    ).toBe("Cards");
  });

  test("humanizes key when title missing", () => {
    expect(fieldDisplayLabel("backgroundColor", {} as SchemaProperty)).toBe(
      "Background Color",
    );
  });
});

describe("resolveActiveFieldKey", () => {
  const properties = {
    layout: { title: "Layout" } as SchemaProperty,
    cards: {
      title: "Cards",
      type: "array",
      items: { type: "object" },
    } as SchemaProperty,
  };

  test("matches array field label at head of breadcrumb", () => {
    expect(
      resolveActiveFieldKey(["layout", "cards"], properties, {}, [
        "Cards",
        "Men's",
      ]),
    ).toBe("cards");
  });

  test("ignores object field labels", () => {
    const withObject = {
      ...properties,
      button: {
        title: "Button",
        type: "object",
        properties: {},
      } as SchemaProperty,
    };
    expect(
      resolveActiveFieldKey(["layout", "button"], withObject, {}, ["Button"]),
    ).toBeNull();
  });

  test("returns null when breadcrumb empty", () => {
    expect(resolveActiveFieldKey(["layout"], properties, {}, [])).toBeNull();
  });
});

describe("isArrayDrillDownField", () => {
  test("detects plain arrays", () => {
    expect(
      isArrayDrillDownField({
        type: "array",
        items: { type: "object" },
      } as SchemaProperty),
    ).toBe(true);
  });

  test("detects page multivariate section arrays", () => {
    expect(
      isArrayDrillDownField({
        type: "block-ref",
        anyOfRefs: [
          {
            resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
            title: "Page Variants",
            schema: {
              type: "object",
              properties: {
                variants: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      value: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
          },
        ],
      } as SchemaProperty),
    ).toBe(true);
  });
});

describe("resolveArrayItemSelection", () => {
  const itemSchema = {
    type: "object",
    properties: { title: { type: "string", title: "Title" } },
  } as SchemaProperty;
  const items = [{ title: "Men's" }, { title: "Women's" }];

  test("finds item after array label anywhere in path", () => {
    expect(
      resolveArrayItemSelection(
        "Cards",
        ["Options", "Cards", "Men's"],
        items,
        itemSchema,
      ),
    ).toEqual({ index: 0, innerPath: [] });
  });

  test("returns inner path for nested array drill-down", () => {
    expect(
      resolveArrayItemSelection(
        "Cards",
        ["Cards", "Men's", "Tags", "Sale"],
        items,
        itemSchema,
      ),
    ).toEqual({ index: 0, innerPath: ["Tags", "Sale"] });
  });

  test("supports legacy breadcrumb without array label", () => {
    expect(
      resolveArrayItemSelection(
        "Cards",
        ["Men's", "Button"],
        items,
        itemSchema,
      ),
    ).toEqual({ index: 0, innerPath: ["Button"] });
  });
});

import { describe, expect, test } from "bun:test";
import type { SchemaProperty } from "./resolve-schema";
import {
  breadcrumbPathForActiveField,
  buildArrayDrillDownBreadcrumb,
  fieldDisplayLabel,
  isArrayDrillDownField,
  resolveActiveFieldKey,
  resolveArrayItemSelection,
  isBreadcrumbInsideObject,
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

  test("matches array field label anywhere in breadcrumb trail", () => {
    expect(
      resolveActiveFieldKey(["layout", "cards"], properties, {}, [
        "Options",
        "Cards",
        "Men's",
      ]),
    ).toBe("cards");
  });

  test("finds nested array field inside object ancestor", () => {
    const globalHeader = {
      logos: { title: "Logos", type: "object", properties: {} },
      alert: {
        title: "Alert",
        type: "object",
        properties: {
          alerts: {
            title: "Alerts",
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string", title: "Text" },
                url: { type: "string", title: "Url" },
              },
            },
          },
          sliderInterval: { type: "number", title: "Slider interval" },
        },
      },
    } satisfies Record<string, SchemaProperty>;

    expect(
      resolveActiveFieldKey(
        Object.keys(globalHeader),
        globalHeader,
        {
          alert: {
            alerts: [{ text: "A Utah Proud Brand Since 1921", url: "/sale" }],
          },
        },
        ["A Utah Proud Brand Since 1921"],
      ),
    ).toBe("alert");
  });

  test("matches array field when runtime value is an array", () => {
    const properties = {
      appKey: { type: "string", title: "App Key" } as SchemaProperty,
      flags: {
        title: "Flags Personalizada",
        type: "object",
      } as SchemaProperty,
    };

    expect(
      resolveActiveFieldKey(
        ["appKey", "flags"],
        properties,
        {
          flags: [{ name: "Sale" }, { name: "Holiday" }],
        },
        ["Flags Personalizada", "Sale"],
      ),
    ).toBe("flags");
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

describe("buildArrayDrillDownBreadcrumb", () => {
  test("includes array label before item label", () => {
    expect(
      buildArrayDrillDownBreadcrumb([], "Flag Desconto", "Partiu ferias"),
    ).toEqual(["Flag Desconto", "Partiu ferias"]);
  });

  test("does not duplicate crumbs already in trail", () => {
    expect(
      buildArrayDrillDownBreadcrumb(
        ["Flag Desconto", "Partiu ferias"],
        "Flag Desconto",
        "Partiu ferias",
      ),
    ).toEqual(["Flag Desconto", "Partiu ferias"]);
  });
});

describe("breadcrumbPathForActiveField", () => {
  const schema = {
    title: "Flag Desconto",
    type: "array",
    items: { type: "object" },
  } as SchemaProperty;

  test("strips array field label from head", () => {
    expect(
      breadcrumbPathForActiveField("flags", schema, [
        "Flag Desconto",
        "Partiu ferias",
      ]),
    ).toEqual(["Partiu ferias"]);
  });

  test("keeps trail when head is item label", () => {
    expect(
      breadcrumbPathForActiveField("flags", schema, ["Partiu ferias"]),
    ).toEqual(["Partiu ferias"]);
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
      resolveArrayItemSelection("Cards", ["Men's", "Sale"], items, itemSchema),
    ).toEqual({ index: 0, innerPath: ["Sale"] });
  });

  test("supports breadcrumb without array label", () => {
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

describe("isBreadcrumbInsideObject", () => {
  const alertSchema = {
    title: "Alert",
    type: "object",
    properties: {
      alerts: {
        title: "Alerts",
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string", title: "Text" },
            url: { type: "string", title: "Url" },
          },
        },
      },
      sliderInterval: { type: "number", title: "Slider interval" },
    },
  } as SchemaProperty;

  test("detects nested array drill-down without object label in trail", () => {
    expect(
      isBreadcrumbInsideObject(
        "alert",
        "Alert",
        alertSchema,
        {
          alerts: [{ text: "A Utah Proud Brand Since 1921", url: "/sale" }],
        },
        ["A Utah Proud Brand Since 1921"],
      ),
    ).toBe(true);
  });

  test("detects breadcrumb that starts with object label", () => {
    expect(
      isBreadcrumbInsideObject("alert", "Alert", alertSchema, { alerts: [] }, [
        "Alert",
        "Alerts",
      ]),
    ).toBe(true);
  });

  test("returns false when breadcrumb targets another object", () => {
    expect(
      isBreadcrumbInsideObject("alert", "Alert", alertSchema, { alerts: [] }, [
        "Logos",
      ]),
    ).toBe(false);
  });
});

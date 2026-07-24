import { describe, expect, test } from "bun:test";
import type { SchemaProperty } from "./resolve-schema";
import {
  breadcrumbPathForActiveField,
  breadcrumbsForHeaderClick,
  buildArrayDrillDownBreadcrumb,
  consumedBreadcrumbPrefix,
  fieldDisplayLabel,
  findBreadcrumbLabelIndex,
  isArrayDrillDownField,
  normalizeBreadcrumbLabel,
  resolveActiveFieldKey,
  resolveArrayItemSelection,
  isBreadcrumbInsideObject,
} from "./schema-form-breadcrumb";
import { PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE } from "./section-types";

describe("normalizeBreadcrumbLabel", () => {
  test("normalizes composed characters to NFC", () => {
    const nfd = "cafe\u0301";
    const nfc = "caf\u00e9";
    expect(normalizeBreadcrumbLabel(nfd)).toBe(normalizeBreadcrumbLabel(nfc));
  });
});

describe("breadcrumbsForHeaderClick", () => {
  test("maps header index to breadcrumb trail", () => {
    const breadcrumbs = ["Global Sections", "Analytics"];
    expect(breadcrumbsForHeaderClick(breadcrumbs, 0)).toEqual([]);
    expect(breadcrumbsForHeaderClick(breadcrumbs, 1)).toEqual([
      "Global Sections",
    ]);
    expect(breadcrumbsForHeaderClick(breadcrumbs, 2)).toEqual([
      "Global Sections",
      "Analytics",
    ]);
  });
});

describe("findBreadcrumbLabelIndex", () => {
  test("matches labels with NFC normalization", () => {
    const nfd = "cafe\u0301";
    const nfc = "caf\u00e9";
    expect(findBreadcrumbLabelIndex(["Flag", nfd], nfc)).toBe(1);
  });
});

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

  test("disambiguates block-refs with same label by inner value keys", () => {
    const properties = {
      asideMenu: {
        title: "Section",
        type: "block-ref",
        anyOfRefs: [{ resolveType: "AsideMenu.tsx", title: "Aside" }],
      } as SchemaProperty,
      content: {
        title: "Section",
        type: "block-ref",
        anyOfRefs: [{ resolveType: "CategoryTextHero.tsx", title: "Hero" }],
      } as SchemaProperty,
    };
    const objValue = {
      asideMenu: {
        __resolveType: "AsideMenu.tsx",
        menuItems: [{ label: "Garantia Vitalícia" }],
      },
      content: {
        __resolveType: "CategoryTextHero.tsx",
        textSeo: [{ matcher: "/garantia-vitalicia" }],
      },
    };
    // "Text Seo" matches humanize("textSeo") in content, not asideMenu
    expect(
      resolveActiveFieldKey(["asideMenu", "content"], properties, objValue, [
        "Section",
        "Text Seo",
        "Garantia Vitalícia",
      ]),
    ).toBe("content");
  });

  test("disambiguates block-refs when breadcrumb uses schema title casing", () => {
    // Schema title "TextSeo" vs humanize("textSeo") = "Text Seo"
    const properties = {
      asideMenu: {
        title: "Section",
        type: "block-ref",
        anyOfRefs: [{ resolveType: "AsideMenu.tsx", title: "Aside" }],
      } as SchemaProperty,
      content: {
        title: "Section",
        type: "block-ref",
        anyOfRefs: [{ resolveType: "CategoryTextHero.tsx", title: "Hero" }],
      } as SchemaProperty,
    };
    const objValue = {
      asideMenu: {
        __resolveType: "AsideMenu.tsx",
        menuItems: [{ label: "Garantia Vitalícia" }],
      },
      content: {
        __resolveType: "CategoryTextHero.tsx",
        textSeo: [{ matcher: "/garantia-vitalicia" }],
      },
    };
    // "TextSeo" (schema title) should match value key "textSeo" via loose comparison
    expect(
      resolveActiveFieldKey(["asideMenu", "content"], properties, objValue, [
        "Section",
        "TextSeo",
        "/garantia-vitalicia",
      ]),
    ).toBe("content");
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
  test("omits the array label — drills straight from section to item", () => {
    // The array is an implementation detail (its list is shown inline in the
    // parent); the breadcrumb jumps straight to the item so there's no
    // redundant "list only" crumb to click back through.
    expect(
      buildArrayDrillDownBreadcrumb([], "Flag Desconto", "Partiu ferias"),
    ).toEqual(["Partiu ferias"]);
  });

  test("keeps the array label to disambiguate an item labelled like the array", () => {
    // Item label == array label (e.g. label driven by `alt`): keep the array
    // crumb so breadcrumbPathForActiveField can tell the two levels apart.
    expect(buildArrayDrillDownBreadcrumb([], "Banner", "Banner")).toEqual([
      "Banner",
      "Banner",
    ]);
  });

  test("keeps the array label to disambiguate an item labelled like the array KEY", () => {
    // Item label == array's property key: breadcrumbPathForActiveField strips a
    // head crumb matching the key too, so the array crumb must be kept.
    expect(
      buildArrayDrillDownBreadcrumb([], "Products", "items", {
        arrayKey: "items",
      }),
    ).toEqual(["Products", "items"]);
  });

  test("keeps the array label when a sibling array/drill-down field exists", () => {
    // A bare [itemLabel] trail can't say WHICH sibling array the item belongs to
    // (two label-less arrays both fall back to "Item N"), so keep the array
    // label as a disambiguator when siblings are present.
    expect(
      buildArrayDrillDownBreadcrumb([], "Logos", "Item 1", {
        hasSiblingDrillDownFields: true,
      }),
    ).toEqual(["Logos", "Item 1"]);
  });

  test("omits the array label when it is the sole drill-down field in scope", () => {
    expect(
      buildArrayDrillDownBreadcrumb([], "Images", "Item 1", {
        arrayKey: "images",
        hasSiblingDrillDownFields: false,
      }),
    ).toEqual(["Item 1"]);
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

  test("nested drill-down stays free of array labels (no doubled crumb)", () => {
    // Opening an item inside an already-open item appends only the new item
    // label — the intermediate array levels never enter the trail.
    expect(
      buildArrayDrillDownBreadcrumb(["Leve 3 pague 2"], "Images", "Detroit"),
    ).toEqual(["Leve 3 pague 2", "Detroit"]);
  });
});

describe("sibling array disambiguation (regression)", () => {
  // Two sibling arrays of label-less objects: getArrayItemLabel falls back to
  // "Item N" for both, so a bare ["Item 1"] trail is ambiguous. The array label
  // must be kept, and the correct array must resolve — otherwise clicking one
  // array's item opens the other (the wrong-array bug).
  const itemSchema = {
    type: "object",
    properties: { src: { type: "string", title: "Src" } },
  } as SchemaProperty;
  const properties = {
    images: { title: "Images", type: "array", items: itemSchema },
    logos: { title: "Logos", type: "array", items: itemSchema },
  } as Record<string, SchemaProperty>;
  const objValue = { images: [{ src: "a" }], logos: [{ src: "b" }] };

  test("keeps array label and resolves to the clicked array, not the first sibling", () => {
    const trail = buildArrayDrillDownBreadcrumb([], "Logos", "Item 1", {
      arrayKey: "logos",
      hasSiblingDrillDownFields: true,
    });
    expect(trail).toEqual(["Logos", "Item 1"]);
    expect(
      resolveActiveFieldKey(
        Object.keys(properties),
        properties,
        objValue,
        trail,
      ),
    ).toBe("logos");
  });

  test("sole array resolves from a bare [itemLabel] trail", () => {
    const soleProps = {
      cards: { title: "Cards", type: "array", items: { type: "object" } },
    } as Record<string, SchemaProperty>;
    const trail = buildArrayDrillDownBreadcrumb([], "Cards", "Men's", {
      arrayKey: "cards",
      hasSiblingDrillDownFields: false,
    });
    expect(trail).toEqual(["Men's"]);
    expect(
      resolveActiveFieldKey(
        ["cards"],
        soleProps,
        { cards: [{ title: "Men's" }] },
        trail,
      ),
    ).toBe("cards");
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

describe("consumedBreadcrumbPrefix", () => {
  test("returns the crumbs dropped from the front", () => {
    expect(consumedBreadcrumbPrefix(["Banner", "Banner"], ["Banner"])).toEqual([
      "Banner",
    ]);
  });

  test("is empty when nothing was consumed", () => {
    expect(consumedBreadcrumbPrefix(["Hello"], ["Hello"])).toEqual([]);
    expect(consumedBreadcrumbPrefix([], [])).toEqual([]);
  });

  test("round-trips: prefix + relative trail reconstructs the full trail", () => {
    const full = ["Banner", "Banner"];
    const relative = breadcrumbPathForActiveField(
      "banner",
      {
        title: "Banner",
        type: "array",
        items: { type: "object" },
      } as SchemaProperty,
      full,
    );
    // A child editing its own crumb reports the updated RELATIVE trail…
    const childReported = ["Banner Sale"];
    // …and re-prepending the consumed prefix must preserve the ancestor crumb,
    // not collapse it (the array-label == item-label focus-loss bug).
    expect([
      ...consumedBreadcrumbPrefix(full, relative),
      ...childReported,
    ]).toEqual(["Banner", "Banner Sale"]);
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

  test("selects item when its label equals the array label (alt-driven label)", () => {
    // Array "Banner" whose single item is also labelled "Banner" (its label
    // comes from `alt`). As long as the consumed prefix is preserved, the
    // relative trail keeps the item crumb and resolution finds it.
    const bannerItems = [{ alt: "Banner Sale" }];
    const bannerSchema = {
      type: "object",
      properties: { alt: { type: "string", title: "Alt" } },
    } as SchemaProperty;
    expect(
      resolveArrayItemSelection(
        "Banner",
        ["Banner Sale"],
        bannerItems,
        bannerSchema,
        0,
      ),
    ).toEqual({ index: 0, innerPath: [] });
  });

  describe("duplicate labels (preferredIndex)", () => {
    // Two items resolve to the same crumb — e.g. after Duplicate, or while
    // editing a label field (alt/name/title) to a value a sibling already uses.
    const dupItems = [{ title: "Hello" }, { title: "Hello" }];

    test("without preferredIndex, first matching item wins", () => {
      expect(
        resolveArrayItemSelection("Cards", ["Hello"], dupItems, itemSchema),
      ).toEqual({ index: 0, innerPath: [] });
    });

    test("keeps the opened item when its label collides with an earlier sibling", () => {
      // Editing item 1 whose label just became equal to item 0's — selection
      // must stay on 1, not snap back to 0 (the focus-loss bug).
      expect(
        resolveArrayItemSelection("Cards", ["Hello"], dupItems, itemSchema, 1),
      ).toEqual({ index: 1, innerPath: [] });
    });

    test("ignores a preferredIndex whose label no longer matches the crumb", () => {
      expect(
        resolveArrayItemSelection(
          "Cards",
          ["Women's"],
          items,
          itemSchema,
          0, // preferred item 0 is "Men's" — doesn't match, fall back to search
        ),
      ).toEqual({ index: 1, innerPath: [] });
    });

    test("ignores an out-of-range preferredIndex", () => {
      expect(
        resolveArrayItemSelection("Cards", ["Hello"], dupItems, itemSchema, 5),
      ).toEqual({ index: 0, innerPath: [] });
    });
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

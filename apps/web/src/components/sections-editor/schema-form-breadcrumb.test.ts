import { describe, expect, test } from "bun:test";
import type { SchemaProperty } from "./resolve-schema";
import {
  breadcrumbPathForActiveField,
  breadcrumbsForHeaderClick,
  buildArrayDrillDownBreadcrumb,
  consumedBreadcrumbPrefix,
  headerBackTargetIndex,
  fieldDisplayLabel,
  findBreadcrumbLabelIndex,
  isArrayDrillDownField,
  normalizeBreadcrumbLabel,
  resolveActiveFieldKey,
  resolveArrayItemSelection,
  isBreadcrumbInsideObject,
} from "./schema-form-breadcrumb";
import { getArrayItemLabel, getArrayItemLabels } from "./array-item-display";
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

describe("headerBackTargetIndex", () => {
  test("targets the parent of the last crumb by default", () => {
    // [page, section] → back exits the section (index 0).
    expect(headerBackTargetIndex(2, { isMultivariateSectionTop: false })).toBe(
      0,
    );
    // [page, section, field] → back returns to the section top (index 1).
    expect(headerBackTargetIndex(3, { isMultivariateSectionTop: false })).toBe(
      1,
    );
  });

  test("exits the section from a multivariate section top", () => {
    // [page, section, variant] would resolve to index 1 (the redundant section
    // crumb, a no-op). Back must exit the section instead.
    expect(headerBackTargetIndex(3, { isMultivariateSectionTop: true })).toBe(
      0,
    );
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

  test("narrows to a loader whose inline config owns the drilled item", () => {
    // Multi-field section: several sibling props + a loader (block-ref) whose
    // config holds a `banners` array. Drilling into the "Beach Short" banner
    // produces a bare `[itemLabel]` trail; the section must still narrow to the
    // loader (not keep showing the sibling toggles).
    const properties = {
      enableCta: { title: "Ativar CTA", type: "boolean" },
      enableBanners: { title: "Ativar modo de banners", type: "boolean" },
      loader: {
        title: "Loader",
        type: "block-ref",
        anyOfRefs: [{ resolveType: "shelf/loader.ts", title: "Shelf" }],
      },
    } satisfies Record<string, SchemaProperty>;
    const objValue = {
      enableCta: true,
      enableBanners: false,
      loader: {
        __resolveType: "shelf/loader.ts",
        banners: [{ title: "Linha Outdoors" }, { title: "Beach Short" }],
      },
    };
    expect(
      resolveActiveFieldKey(Object.keys(properties), properties, objValue, [
        "Beach Short",
      ]),
    ).toBe("loader");
  });

  test("narrows to a GLOBAL loader whose decofile data owns the drilled item", () => {
    const properties = {
      enableCta: { title: "Ativar CTA", type: "boolean" },
      loader: {
        title: "Loader",
        type: "block-ref",
        anyOfRefs: [{ resolveType: "shelf/loader.ts", title: "Shelf" }],
      },
    } satisfies Record<string, SchemaProperty>;
    // Global loader: the field value is just a reference; the real config
    // (with the `banners` array) lives in the decofile under that key.
    const objValue = {
      enableCta: true,
      loader: { __resolveType: "carrossel-home-loader" },
    };
    const decofile = {
      "carrossel-home-loader": {
        __resolveType: "shelf/loader.ts",
        name: "carrossel-home-loader",
        banners: [{ title: "Linha Outdoors" }, { title: "Beach Short" }],
      },
    };
    expect(
      resolveActiveFieldKey(
        Object.keys(properties),
        properties,
        objValue,
        ["Beach Short"],
        decofile,
      ),
    ).toBe("loader");
    // Without the decofile the reference can't be resolved, so it can't narrow.
    expect(
      resolveActiveFieldKey(Object.keys(properties), properties, objValue, [
        "Beach Short",
      ]),
    ).toBeNull();
  });

  test("does not narrow to a loader whose config does not own the crumb", () => {
    const properties = {
      enableCta: { title: "Ativar CTA", type: "boolean" },
      loader: {
        title: "Loader",
        type: "block-ref",
        anyOfRefs: [{ resolveType: "shelf/loader.ts", title: "Shelf" }],
      },
    } satisfies Record<string, SchemaProperty>;
    const objValue = {
      enableCta: true,
      loader: {
        __resolveType: "shelf/loader.ts",
        banners: [{ title: "Linha Outdoors" }],
      },
    };
    expect(
      resolveActiveFieldKey(Object.keys(properties), properties, objValue, [
        "Beach Short",
      ]),
    ).toBeNull();
  });

  test("does not spuriously match primitive arrays or href/id fallbacks", () => {
    const properties = {
      loader: {
        title: "Loader",
        type: "block-ref",
        anyOfRefs: [{ resolveType: "shelf/loader.ts", title: "Shelf" }],
      },
    } satisfies Record<string, SchemaProperty>;
    // The crumb "Beach Short" appears only as a primitive tag and as an
    // `href`/`id` — never as a real item name/label/title — so ownership must
    // NOT be claimed (would otherwise narrow to the wrong field).
    const objValue = {
      loader: {
        __resolveType: "shelf/loader.ts",
        tags: ["Beach Short"],
        links: [{ href: "Beach Short", id: "Beach Short" }],
      },
    };
    expect(
      resolveActiveFieldKey(Object.keys(properties), properties, objValue, [
        "Beach Short",
      ]),
    ).toBeNull();
  });

  test("narrows to the loader that actually owns the item, not the first block-ref", () => {
    const properties = {
      loaderA: {
        title: "Loader A",
        type: "block-ref",
        anyOfRefs: [{ resolveType: "a/loader.ts", title: "A" }],
      },
      loaderB: {
        title: "Loader B",
        type: "block-ref",
        anyOfRefs: [{ resolveType: "b/loader.ts", title: "B" }],
      },
    } satisfies Record<string, SchemaProperty>;
    const objValue = {
      loaderA: {
        __resolveType: "a/loader.ts",
        banners: [{ title: "Linha Outdoors" }],
      },
      loaderB: {
        __resolveType: "b/loader.ts",
        banners: [{ title: "Beach Short" }],
      },
    };
    expect(
      resolveActiveFieldKey(Object.keys(properties), properties, objValue, [
        "Beach Short",
      ]),
    ).toBe("loaderB");
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

  describe("inline-union branch drill-down", () => {
    // `searchProps` is an "A or B" plain-data union; its "Busca avançada" branch
    // holds a `selectedFacets: Facet[]`. Drilling into a Facet writes a bare
    // ["Facet"] trail (the union's own label never enters it), so the section
    // must still narrow to `searchProps` instead of showing every sibling prop.
    const properties = {
      searchProps: {
        title: "Parâmetros de busca",
        type: "inline-union",
        inlineUnionBranches: [
          {
            title: "Busca avançada",
            discriminators: { type: "advanced" },
            schema: {
              type: "object",
              properties: {
                term: { type: "string", title: "Termo de busca" },
                selectedFacets: {
                  title: "Filtros base",
                  type: "array",
                  items: {
                    type: "object",
                    title: "Facet",
                    properties: {
                      key: { type: "string", title: "Chave do facet" },
                      value: { type: "string", title: "Valor do facet" },
                    },
                  },
                },
              },
            },
          },
          {
            title: "ID de coleção",
            discriminators: { type: "cluster" },
            schema: {
              type: "object",
              properties: { clusterId: { type: "string", title: "Cluster" } },
            },
          },
        ],
      },
      titlesSEOPLPs: {
        title: "Títulos e textos SEO (PLP)",
        type: "array",
        items: { type: "object", properties: { label: { type: "string" } } },
      },
      floatingControls: { title: "Controles flutuantes", type: "boolean" },
    } as Record<string, SchemaProperty>;

    test("narrows to the union field whose selected branch owns the item", () => {
      // Empty facet ({}) → label falls back to the item schema title "Facet".
      const objValue = {
        searchProps: { type: "advanced", selectedFacets: [{}] },
        titlesSEOPLPs: [],
        floatingControls: true,
      };
      expect(
        resolveActiveFieldKey(Object.keys(properties), properties, objValue, [
          "Facet",
        ]),
      ).toBe("searchProps");
    });

    test("resolves via the union's own label crumb (viaLabel path)", () => {
      // Trail led by the union field's label — the drill kept it as a
      // disambiguator. Must resolve through the `labelsMatch(head, label)` +
      // slice(1) branch of the inline-union loop, not the direct one.
      const objValue = {
        searchProps: { type: "advanced", selectedFacets: [{}] },
        titlesSEOPLPs: [],
        floatingControls: true,
      };
      expect(
        resolveActiveFieldKey(Object.keys(properties), properties, objValue, [
          "Parâmetros de busca",
          "Facet",
        ]),
      ).toBe("searchProps");
    });

    test("does not narrow off an inactive branch's schema", () => {
      // The "cluster" branch is active (no `selectedFacets` in the value). A
      // "Facet" crumb — a field only the inactive "advanced" branch declares —
      // must NOT spuriously narrow to searchProps: the match is gated by the
      // union value's actual data, which carries no facets here.
      const objValue = {
        searchProps: { type: "cluster", clusterId: "123" },
        titlesSEOPLPs: [],
        floatingControls: true,
      };
      expect(
        resolveActiveFieldKey(Object.keys(properties), properties, objValue, [
          "Facet",
        ]),
      ).toBeNull();
    });

    test("does not hijack a crumb owned by a sibling array", () => {
      // Ordering guard: the pre-existing array-item loop resolves the sibling
      // array before the inline-union loop runs, so adding the union loop must
      // not pre-empt a real sibling match.
      const objValue = {
        searchProps: { type: "advanced", selectedFacets: [{}] },
        titlesSEOPLPs: [{ label: "Home SEO" }],
        floatingControls: true,
      };
      expect(
        resolveActiveFieldKey(Object.keys(properties), properties, objValue, [
          "Home SEO",
        ]),
      ).toBe("titlesSEOPLPs");
    });
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
    ).toEqual({ index: 0, innerPath: [], crumbIndex: 2 });
  });

  test("returns inner path for nested array drill-down", () => {
    expect(
      resolveArrayItemSelection("Cards", ["Men's", "Sale"], items, itemSchema),
    ).toEqual({ index: 0, innerPath: ["Sale"], crumbIndex: 0 });
  });

  test("supports breadcrumb without array label", () => {
    expect(
      resolveArrayItemSelection(
        "Cards",
        ["Men's", "Button"],
        items,
        itemSchema,
      ),
    ).toEqual({ index: 0, innerPath: ["Button"], crumbIndex: 0 });
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
    ).toEqual({ index: 0, innerPath: [], crumbIndex: 0 });
  });

  describe("duplicate labels", () => {
    // Two items share a base label ("Hello") — e.g. after Duplicate, or when an
    // object array has no distinguishing field so every row falls back to the
    // item schema title. getArrayItemLabel disambiguates them positionally
    // ("Hello 1" / "Hello 2"), so each item stays uniquely addressable by its
    // crumb even after a form remount clears the transiently-opened index.
    const dupItems = [{ title: "Hello" }, { title: "Hello" }];

    test("addresses each duplicate by its positional crumb (no preferredIndex)", () => {
      expect(
        resolveArrayItemSelection("Cards", ["Hello 1"], dupItems, itemSchema),
      ).toEqual({ index: 0, innerPath: [], crumbIndex: 0 });
      expect(
        resolveArrayItemSelection("Cards", ["Hello 2"], dupItems, itemSchema),
      ).toEqual({ index: 1, innerPath: [], crumbIndex: 0 });
    });

    test("a bare (non-disambiguated) crumb no longer matches a duplicate", () => {
      // The old behaviour silently resolved a shared label to the first item;
      // now the crumb must carry the position, so a bare label finds nothing.
      expect(
        resolveArrayItemSelection("Cards", ["Hello"], dupItems, itemSchema),
      ).toBeNull();
    });

    test("keeps the opened item when a preferredIndex is supplied", () => {
      expect(
        resolveArrayItemSelection(
          "Cards",
          ["Hello 2"],
          dupItems,
          itemSchema,
          1,
        ),
      ).toEqual({ index: 1, innerPath: [], crumbIndex: 0 });
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
      ).toEqual({ index: 1, innerPath: [], crumbIndex: 0 });
    });

    test("falls back to crumb search when preferredIndex is out of range", () => {
      expect(
        resolveArrayItemSelection(
          "Cards",
          ["Hello 2"],
          dupItems,
          itemSchema,
          5,
        ),
      ).toEqual({ index: 1, innerPath: [], crumbIndex: 0 });
    });
  });
});

describe("resolveArrayItemSelection crumbIndex", () => {
  const schema = {
    type: "object",
    properties: { title: { type: "string", title: "Title" } },
  } as SchemaProperty;
  const items = [{ title: "Men's" }, { title: "Women's" }];

  test("points at the item crumb, before its inner trail", () => {
    // Trail [Section, Cards, Men's, Inner]: the item crumb is at index 2.
    expect(
      resolveArrayItemSelection(
        "Cards",
        ["Section", "Cards", "Men's", "Inner"],
        items,
        schema,
      ),
    ).toEqual({ index: 0, innerPath: ["Inner"], crumbIndex: 2 });
  });

  test("is the last crumb when innerPath is empty", () => {
    expect(
      resolveArrayItemSelection("Cards", ["Women's"], items, schema),
    ).toEqual({ index: 1, innerPath: [], crumbIndex: 0 });
  });
});

describe("editing an item's label keeps it selected (crumb re-sync)", () => {
  // Reproduces the reported bug: duplicate a banner (two share a label), open
  // the copy, edit its text. The editor must stay on the copy — not snap back
  // to the "original" it was duplicated from. Runs the exact sequence
  // ArrayField.updateItem runs against the real functions: resolve selection →
  // rewrite the crumb at `selection.crumbIndex` → re-resolve against the edits.
  const schema = {
    type: "object",
    properties: { title: { type: "string", title: "Title" } },
  } as SchemaProperty;

  // Mirror ArrayField.updateItem's crumb re-sync exactly (same label helper it
  // uses, `getArrayItemLabel` with siblings), so this test tracks the component
  // rather than re-deriving the label a different way.
  const rewriteAndReresolve = (
    items: unknown[],
    trail: string[],
    openIndex: number,
    edited: unknown[],
  ) => {
    const selection = resolveArrayItemSelection(
      "Banners",
      trail,
      items,
      schema,
      openIndex,
    );
    if (!selection) throw new Error("expected a selection");
    const oldLabel = getArrayItemLabel(
      items[openIndex],
      openIndex,
      schema,
      items,
    );
    const newLabel = getArrayItemLabel(
      edited[openIndex],
      openIndex,
      schema,
      edited,
    );
    let nextTrail = trail;
    if (oldLabel !== newLabel) {
      nextTrail = [...trail];
      nextTrail[selection.crumbIndex] = newLabel;
    }
    return {
      nextTrail,
      selection: resolveArrayItemSelection(
        "Banners",
        nextTrail,
        edited,
        schema,
        openIndex,
      ),
    };
  };

  test("editing the duplicate's title stays on the duplicate, not the original", () => {
    const items = [{ title: "Cozinha" }, { title: "Cozinha" }];
    const trail = [getArrayItemLabels(items, schema)[1]!]; // open the copy
    const edited = [{ title: "Cozinha" }, { title: "Cozinha Nova" }];
    expect(rewriteAndReresolve(items, trail, 1, edited).selection).toEqual({
      index: 1,
      innerPath: [],
      crumbIndex: 0,
    });
  });

  test("clearing the title mid-edit (label falls back) keeps the same item", () => {
    // Emptying the label field makes the row fall back to the schema-title
    // suffix; the crumb still tracks it because it is rewritten by position.
    const items = [{ title: "Cozinha" }, { title: "Cozinha" }];
    const trail = [getArrayItemLabels(items, schema)[1]!];
    const edited = [{ title: "Cozinha" }, { title: "" }];
    expect(rewriteAndReresolve(items, trail, 1, edited).selection).toEqual({
      index: 1,
      innerPath: [],
      crumbIndex: 0,
    });
  });

  test("editing a non-label field leaves the crumb untouched (no-op)", () => {
    // oldLabel === newLabel → updateItem must not rewrite the breadcrumb.
    const withExtra = {
      type: "object",
      properties: {
        title: { type: "string", title: "Title" },
        href: { type: "string", title: "Href" },
      },
    } as SchemaProperty;
    const items = [{ title: "Cozinha", href: "/a" }];
    const trail = ["Cozinha"];
    const selection = resolveArrayItemSelection(
      "Banners",
      trail,
      items,
      withExtra,
      0,
    );
    const edited = [{ title: "Cozinha", href: "/b" }]; // label field unchanged
    const oldLabel = getArrayItemLabel(items[0], 0, withExtra, items);
    const newLabel = getArrayItemLabel(edited[0], 0, withExtra, edited);
    expect(oldLabel).toBe(newLabel); // title drives the label; href doesn't
    // Trail stays as-is; re-resolving still lands on the item.
    expect(selection).toEqual({ index: 0, innerPath: [], crumbIndex: 0 });
  });

  test("editing an item drilled one level deep keeps the inner trail", () => {
    // Trail [item, Inner]: the item crumb is at position 0, so rewriting it
    // must leave the inner crumb ("Inner") untouched.
    const items = [{ title: "Cozinha" }, { title: "Cozinha" }];
    const trail = [getArrayItemLabels(items, schema)[1]!, "Inner"];
    const edited = [{ title: "Cozinha" }, { title: "Cozinha Nova" }];
    const { nextTrail, selection } = rewriteAndReresolve(
      items,
      trail,
      1,
      edited,
    );
    expect(nextTrail).toEqual(["Cozinha Nova", "Inner"]);
    expect(selection).toEqual({
      index: 1,
      innerPath: ["Inner"],
      crumbIndex: 0,
    });
  });
});

describe("array item label build↔resolve round-trip", () => {
  // The fix's core promise: a crumb built from getArrayItemLabels must resolve
  // back to the same item with no transient state — this is what survives a
  // form remount. Exercises both seams together, not hand-copied literals.
  const roundTrips = (items: unknown[], schema: SchemaProperty) => {
    const labels = getArrayItemLabels(items, schema);
    labels.forEach((label, i) => {
      expect(
        resolveArrayItemSelection("Items", [label], items, schema),
      ).toEqual({ index: i, innerPath: [], crumbIndex: 0 });
    });
  };

  test("colliding fallback-title items each resolve to their own index", () => {
    roundTrips([{ body: "a" }, { body: "b" }, { body: "c" }], {
      type: "object",
      title: "Spec",
      properties: { body: { type: "string" } },
    });
  });

  test("NFC/NFD near-duplicates round-trip to distinct indices", () => {
    roundTrips([{ name: "café" }, { name: "café" }], {
      type: "object",
      properties: { name: { type: "string" } },
    });
  });

  test("suffix-vs-literal collision still round-trips uniquely", () => {
    roundTrips([{ title: "X" }, { title: "X" }, { title: "X 2" }], {
      type: "object",
      properties: { title: { type: "string" } },
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

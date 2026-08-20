import { describe, expect, test } from "bun:test";
import type { LiveMeta, SchemaProperty } from "./resolve-schema";
import {
  breadcrumbPathForActiveField,
  breadcrumbsForHeaderClick,
  buildArrayDrillDownBreadcrumb,
  consumedBreadcrumbPrefix,
  type Crumb,
  crumbLabel,
  headerBackTargetIndex,
  fieldDisplayLabel,
  isArrayDrillDownField,
  normalizeBreadcrumbLabel,
  prependCrumbIfAbsent,
  siblingsNeedingAncestorCrumb,
  resolveActiveFieldKey,
  resolveArrayItemSelection,
  siblingFieldLabel,
  isBreadcrumbInsideObject,
} from "./schema-form-breadcrumb";
import {
  getArrayItemDisplayLabels,
  getArrayItemLabel,
} from "./array-item-display";
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

describe("siblingFieldLabel", () => {
  test("falls back to humanized key when siblings share a title", () => {
    // Both props `$ref` the same interface, so both inherit its title.
    const properties = {
      shelfProps: { title: "ProductShelfProps" } as SchemaProperty,
      shelfPropsOffer: { title: "ProductShelfProps" } as SchemaProperty,
    };
    const keys = Object.keys(properties);
    expect(siblingFieldLabel("shelfProps", keys, properties)).toBe(
      "Shelf Props",
    );
    expect(siblingFieldLabel("shelfPropsOffer", keys, properties)).toBe(
      "Shelf Props Offer",
    );
  });

  test("keeps the title when siblings are distinct", () => {
    const properties = {
      alpha: { title: "Alpha" } as SchemaProperty,
      beta: { title: "Beta" } as SchemaProperty,
    };
    expect(
      siblingFieldLabel("alpha", Object.keys(properties), properties),
    ).toBe("Alpha");
  });

  test("keeps the title for a lone property", () => {
    const properties = { cards: { title: "Cards" } as SchemaProperty };
    expect(siblingFieldLabel("cards", ["cards"], properties)).toBe("Cards");
  });
});

describe("prependCrumbIfAbsent", () => {
  test("prepends the label when the trail doesn't start with it", () => {
    expect(
      prependCrumbIfAbsent("Shelf Props Offer", ["Free shipping"]),
    ).toEqual(["Shelf Props Offer", "Free shipping"]);
  });

  test("prepends onto an empty trail", () => {
    expect(prependCrumbIfAbsent("Shelf Props Offer", [])).toEqual([
      "Shelf Props Offer",
    ]);
  });

  test("is a no-op when the label is already the head (NFC-insensitive)", () => {
    const trail = ["café", "Free shipping"];
    // Same crumb in composed form must be recognized as already present.
    expect(prependCrumbIfAbsent("café", trail)).toBe(trail);
  });
});

describe("resolveActiveFieldKey — sibling props with identical titles", () => {
  // Mirrors the general shape that triggers the bug: two props that `$ref` the
  // same interface, so both share the title and an identical nested
  // `cardLayout.tags` shape. Item labels come from the `label` field. Fixture
  // labels are neutral placeholders — not tied to any real store's content.
  const shelf = {
    type: "object",
    title: "ProductShelfProps",
    properties: {
      cardLayout: {
        type: "object",
        title: "CardLayout",
        properties: {
          tags: {
            type: "array",
            title: "Tags",
            items: {
              type: "object",
              properties: { label: { type: "string" } },
            },
          },
        },
      },
    },
  } satisfies SchemaProperty;
  const properties = { shelfProps: shelf, shelfPropsOffer: shelf };
  const keys = Object.keys(properties);
  const objValue = {
    shelfProps: {
      cardLayout: {
        tags: [{ label: "Summer Sale" }, { label: "Free shipping" }],
      },
    },
    shelfPropsOffer: {
      cardLayout: {
        tags: [{ label: "Winter Sale" }, { label: "Free shipping" }],
      },
    },
  };

  test("a unique item label resolves to its owning sibling", () => {
    expect(
      resolveActiveFieldKey(keys, properties, objValue, ["Winter Sale"]),
    ).toBe("shelfPropsOffer");
    expect(
      resolveActiveFieldKey(keys, properties, objValue, ["Summer Sale"]),
    ).toBe("shelfProps");
  });

  test("a disambiguated ancestor crumb focuses the right sibling for a shared item", () => {
    expect(
      resolveActiveFieldKey(keys, properties, objValue, [
        "Shelf Props Offer",
        "Free shipping",
      ]),
    ).toBe("shelfPropsOffer");
    expect(
      resolveActiveFieldKey(keys, properties, objValue, [
        "Shelf Props",
        "Free shipping",
      ]),
    ).toBe("shelfProps");
  });

  test("a single matching object sibling still resolves (not null)", () => {
    // Only `shelfProps` has a "Summer Sale" tag → one match, returns it.
    expect(
      resolveActiveFieldKey(keys, properties, objValue, ["Summer Sale"]),
    ).toBe("shelfProps");
  });

  test("an ambiguous shared crumb without an ancestor returns null (shows both)", () => {
    expect(
      resolveActiveFieldKey(keys, properties, objValue, ["Free shipping"]),
    ).toBeNull();
  });

  test("breadcrumbPathForActiveField strips the disambiguated ancestor crumb", () => {
    expect(
      breadcrumbPathForActiveField(
        "shelfPropsOffer",
        shelf,
        ["Shelf Props Offer", "Free shipping"],
        "Shelf Props Offer",
      ),
    ).toEqual(["Free shipping"]);
  });
});

describe("resolveActiveFieldKey — distinct-titled siblings with an array crumb", () => {
  // The real-world ProductShelfGroup shape: `shelfProps` and `shelfPropsOffer`
  // have DIFFERENT titles (so they don't collide by display label), yet each
  // holds an identical `cardLayout.productTags` whose items share labels. Because
  // `cardLayout` has TWO arrays (`productTags` + `productSquareTags`), drilling
  // keeps the array-label crumb "ProductTags" in the trail — which matches the
  // array in BOTH siblings. Only the ancestor crumb tells them apart.
  const cardLayout = {
    type: "object",
    title: "CardLayout",
    properties: {
      productTags: {
        type: "array",
        title: "ProductTags",
        items: { type: "object", properties: { label: { type: "string" } } },
      },
      productSquareTags: {
        type: "array",
        title: "ProductSquareTags",
        items: { type: "object", properties: { label: { type: "string" } } },
      },
    },
  } satisfies SchemaProperty;
  const properties = {
    shelfPropsOffer: {
      type: "object",
      title: "ShelfPropsOffer",
      properties: { cardLayout },
    },
    shelfProps: {
      type: "object",
      title: "ShelfProps",
      properties: { cardLayout },
    },
  } satisfies Record<string, SchemaProperty>;
  const keys = Object.keys(properties);
  const tags = [
    { label: "frete grátis geral" },
    { label: "frete grátis smt" },
    { label: "OFERTAS 8.8" },
  ];
  const objValue = {
    shelfPropsOffer: {
      cardLayout: { productTags: tags, productSquareTags: [] },
    },
    shelfProps: { cardLayout: { productTags: tags, productSquareTags: [] } },
  };

  // The array label rides on the item crumb as `arrayLabel` (folded), which is
  // what `buildArrayDrillDownBreadcrumb` now produces — no standalone
  // "ProductTags" crumb.
  const item = {
    label: "frete grátis smt",
    itemIndex: 1,
    arrayLabel: "ProductTags",
  };

  test("without an ancestor crumb the shared item stays ambiguous (shows both)", () => {
    expect(
      resolveActiveFieldKey(keys, properties, objValue, [item]),
    ).toBeNull();
  });

  test("the ancestor crumb pins the sibling even with the folded array label present", () => {
    // This is the regression: pre-fix the array label matched the nested array in
    // BOTH siblings via the loose path, so it returned null (mixed panel) despite
    // the "ShelfProps" ancestor crumb naming exactly one.
    expect(
      resolveActiveFieldKey(keys, properties, objValue, ["ShelfProps", item]),
    ).toBe("shelfProps");
    expect(
      resolveActiveFieldKey(keys, properties, objValue, [
        "ShelfPropsOffer",
        item,
      ]),
    ).toBe("shelfPropsOffer");
  });

  test("siblingsNeedingAncestorCrumb flags both confusable containers", () => {
    const needing = siblingsNeedingAncestorCrumb(keys, properties);
    expect(needing.has("shelfProps")).toBe(true);
    expect(needing.has("shelfPropsOffer")).toBe(true);
  });

  test("siblingsNeedingAncestorCrumb is empty without a confusable sibling", () => {
    const lone = {
      shelfProps: {
        type: "object",
        title: "ShelfProps",
        properties: { cardLayout },
      },
      title: { type: "string", title: "Title" },
    } satisfies Record<string, SchemaProperty>;
    expect(siblingsNeedingAncestorCrumb(Object.keys(lone), lone).size).toBe(0);
  });

  test("siblingsNeedingAncestorCrumb flags block-ref loaders that both carry a nested array (by value)", () => {
    // page + RangePriceProps have no nested-array SCHEMA, only nested-array VALUES.
    const properties = {
      page: {
        type: "block-ref",
        title: "Page",
        anyOfRefs: [
          { resolveType: "vtex/loaders/productListingPage.ts", title: "PLP" },
        ],
      },
      RangePriceProps: {
        type: "block-ref",
        title: "Range Price Props",
        anyOfRefs: [
          {
            resolveType: "site/loaders/RangePriceData.ts",
            title: "Range Price",
          },
        ],
      },
    } satisfies Record<string, SchemaProperty>;
    const objValue = {
      page: {
        __resolveType: "vtex/loaders/productListingPage.ts",
        selectedFacets: [{ key: "category-1", value: "joias" }],
      },
      RangePriceProps: {
        __resolveType: "site/loaders/RangePriceData.ts",
        ProductListingPage: {
          selectedFacets: [{ key: "category-1", value: "joias" }],
        },
      },
    };
    const needing = siblingsNeedingAncestorCrumb(
      Object.keys(properties),
      properties,
      objValue,
    );
    expect(needing.has("page")).toBe(true);
    expect(needing.has("RangePriceProps")).toBe(true);
  });
});

describe("array drill-down pipeline — item label collides with array label/key", () => {
  // Regression guard for the `arrayLabel` fold: when the item's label equals the
  // array's own label (or property key), the disambiguator rides ON the item
  // crumb. `breadcrumbPathForActiveField` must NOT strip that item crumb (it's
  // the array's selection, not the array's own crumb) — otherwise ArrayField gets
  // an empty relative trail, `resolveArrayItemSelection` returns null, and the
  // item can't be opened (it snaps back to the list). This walks the full
  // SchemaForm pipeline: build → resolveActiveFieldKey → breadcrumbPathForActiveField
  // → resolveArrayItemSelection.
  function drillAndSelect(
    key: string,
    properties: Record<string, SchemaProperty>,
    objValue: Record<string, unknown>,
    arrayLabel: string,
    itemLabel: string,
    opts: { arrayKey?: string; hasSiblingDrillDownFields?: boolean },
  ) {
    const keys = Object.keys(properties);
    const trail = buildArrayDrillDownBreadcrumb(
      [],
      arrayLabel,
      itemLabel,
      0,
      opts,
    );
    const activeKey = resolveActiveFieldKey(keys, properties, objValue, trail);
    expect(activeKey).toBe(key);
    const relative = breadcrumbPathForActiveField(
      key,
      properties[key]!,
      trail,
      siblingFieldLabel(key, keys, properties),
    );
    return resolveArrayItemSelection(
      siblingFieldLabel(key, keys, properties),
      relative,
      objValue[key] as unknown[],
      properties[key]!.items,
      null,
    );
  }

  test("item label equals the array label — item still opens", () => {
    const properties = {
      banner: {
        type: "array",
        title: "Banner",
        items: { type: "object", properties: { alt: { type: "string" } } },
      },
    } as Record<string, SchemaProperty>;
    const objValue = { banner: [{ alt: "Banner" }] };
    const selection = drillAndSelect(
      "banner",
      properties,
      objValue,
      "Banner",
      "Banner",
      {},
    );
    expect(selection?.index).toBe(0);
  });

  test("item label equals the array KEY — item still opens", () => {
    const properties = {
      items: {
        type: "array",
        title: "Products",
        items: { type: "object", properties: { label: { type: "string" } } },
      },
    } as Record<string, SchemaProperty>;
    const objValue = { items: [{ label: "items" }] };
    const selection = drillAndSelect(
      "items",
      properties,
      objValue,
      "Products",
      "items",
      { arrayKey: "items" },
    );
    expect(selection?.index).toBe(0);
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

  test("narrows to a loader whose extensions[] item is labelled by __resolveType", () => {
    // ALS /flashsale: the extensions[] item's "DetailsPage" label comes from __resolveType (no name/label/title/alt), so ownership must see it.
    const properties = {
      page: {
        title: "Page",
        type: "block-ref",
        anyOfRefs: [
          {
            resolveType: "commerce/loaders/product/extensions/detailsPage.ts",
            title: "Details Page",
          },
        ],
      },
      defaultSkuFilter: { title: "Default SKU Filter", type: "string" },
      showColorVariantOutOfStock: {
        title: "Show Color Variant Out of Stock",
        type: "boolean",
      },
    } satisfies Record<string, SchemaProperty>;
    const objValue = {
      page: {
        __resolveType: "commerce/loaders/product/extensions/detailsPage.ts",
        data: { __resolveType: "vtex/loaders/legacy/productDetailsPage.ts" },
        extensions: [
          {
            __resolveType: "vtex/loaders/product/extensions/detailsPage.ts",
            simulate: true,
            similars: true,
          },
        ],
      },
      defaultSkuFilter: "only-on-sale",
      showColorVariantOutOfStock: false,
    };
    expect(
      resolveActiveFieldKey(Object.keys(properties), properties, objValue, [
        { label: "DetailsPage", itemIndex: 0 },
      ]),
    ).toBe("page");
  });

  test("matches an object item by its href label, never a primitive-array value", () => {
    const properties = {
      loader: {
        title: "Loader",
        type: "block-ref",
        anyOfRefs: [{ resolveType: "shelf/loader.ts", title: "Shelf" }],
      },
    } satisfies Record<string, SchemaProperty>;
    // A drillable object item with no name/label/title displays (and is addressed) by its href, so ownership must claim it.
    expect(
      resolveActiveFieldKey(
        Object.keys(properties),
        properties,
        {
          loader: {
            __resolveType: "shelf/loader.ts",
            links: [{ href: "Beach Short", id: "x" }],
          },
        },
        ["Beach Short"],
      ),
    ).toBe("loader");
    // The same label present only as a primitive tag can't be drilled into, so it must NOT claim the crumb.
    expect(
      resolveActiveFieldKey(
        Object.keys(properties),
        properties,
        { loader: { __resolveType: "shelf/loader.ts", tags: ["Beach Short"] } },
        ["Beach Short"],
      ),
    ).toBeNull();
  });

  test("narrows to the sibling section whose SCHEMA owns a @titleBy-labelled array item", () => {
    // casaevideo NotFoundChallenge: drilling a URL-labelled coupon in `children` (MountedPDP.pdpCupons, @titleBy couponCode) must not drift to `fallback` (NotFound.categories) — the value scan can't see the title/titleBy, so ownership falls back to the target schema.
    const mountedPdpSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        pdpCupons: {
          type: "array",
          title: "Cupons da PDP",
          items: {
            type: "object",
            titleBy: "couponCode",
            properties: {
              couponCode: { type: "string" },
              discountTitle: { type: "string" },
            },
          },
        },
      },
    };
    const notFoundSchema: Record<string, unknown> = {
      type: "object",
      properties: {
        categories: {
          type: "array",
          title: "Categories",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              link: { type: "string" },
            },
          },
        },
      },
    };
    const meta: LiveMeta = {
      manifest: {
        blocks: {
          sections: {
            "site/sections/Product/MountedPDP.tsx": mountedPdpSchema,
            "site/sections/Product/NotFound.tsx": notFoundSchema,
          },
        },
      },
      schema: {},
    };
    const properties = {
      children: {
        title: "On Product Found",
        type: "block-ref",
        anyOfRefs: [
          {
            resolveType: "site/sections/Product/MountedPDP.tsx",
            title: "MountedPDP",
          },
        ],
      },
      fallback: {
        title: "On Product Not Found",
        type: "block-ref",
        anyOfRefs: [
          {
            resolveType: "site/sections/Product/NotFound.tsx",
            title: "NotFound",
          },
        ],
      },
    } satisfies Record<string, SchemaProperty>;
    const couponUrl =
      "https://www.casaevideo.com.br/3393?map=productClusterIds&order=OrderByTopSaleDESC";
    const objValue = {
      children: {
        __resolveType: "site/sections/Product/MountedPDP.tsx",
        pdpCupons: [{ couponCode: couponUrl, discountTitle: "10% OFF" }],
      },
      fallback: {
        __resolveType: "site/sections/Product/NotFound.tsx",
        categories: [
          { label: "Telefones e Celulares", link: "/telefones-e-celulares" },
          { label: "Ar e ventilação", link: "/" },
        ],
      },
    };
    const crumb: Crumb = {
      label: couponUrl,
      itemIndex: 0,
      arrayLabel: "Cupons da PDP",
    };
    expect(
      resolveActiveFieldKey(
        Object.keys(properties),
        properties,
        objValue,
        [crumb],
        undefined,
        meta,
      ),
    ).toBe("children");
    // Without the schema (no meta) it can't disambiguate, but must NOT wrongly pick `fallback`.
    expect(
      resolveActiveFieldKey(Object.keys(properties), properties, objValue, [
        crumb,
      ]),
    ).not.toBe("fallback");
  });

  test("narrows to a PLP loader whose selectedFacets[] item is labelled by key", () => {
    // ALS/montecarlo/farmrio/osklen: selectedFacets items are {key,value} — the "category-1" label comes from `key`.
    const properties = {
      page: {
        title: "Page",
        type: "block-ref",
        anyOfRefs: [
          {
            resolveType: "vtex/loaders/productListingPage.ts",
            title: "PLP",
          },
        ],
      },
      startingPage: { title: "Starting Page", type: "number" },
      showSortBy: { title: "Show Sort By", type: "boolean" },
    } satisfies Record<string, SchemaProperty>;
    const objValue = {
      page: {
        __resolveType: "vtex/loaders/productListingPage.ts",
        selectedFacets: [{ key: "category-1", value: "shoes" }],
      },
      startingPage: 1,
      showSortBy: true,
    };
    expect(
      resolveActiveFieldKey(Object.keys(properties), properties, objValue, [
        { label: "category-1", itemIndex: 0 },
      ]),
    ).toBe("page");
  });

  test("narrows to a GLOBAL-ref loader via the folded array label on the item crumb", () => {
    // Real ALS Backcountry: `page` is a bare ref to a saved loader; the item's label is titleBy-only so the array name rides FOLDED on the crumb (no visible step).
    const properties = {
      page: {
        title: "Page",
        type: "block-ref",
        anyOfRefs: [
          {
            resolveType: "vtex/loaders/intelligentSearch/productListingPage.ts",
            title: "PLP",
          },
        ],
      },
      isFallback: { title: "Is Fallback", type: "boolean" },
      cardLayout: {
        title: "Card Layout",
        type: "block-ref",
        anyOfRefs: [
          { resolveType: "site/loaders/ProductCardLayout.tsx", title: "Card" },
        ],
      },
    } satisfies Record<string, SchemaProperty>;
    const objValue = {
      page: { __resolveType: "PLP Loader - Backcountry Skiing" },
      isFallback: false,
      cardLayout: { __resolveType: "PDP - Product Card" },
    };
    const decofile = {
      "PLP Loader - Backcountry Skiing": {
        __resolveType: "vtex/loaders/intelligentSearch/productListingPage.ts",
        selectedFacets: [{ key: "productClusterIds", value: "1211" }],
      },
    };
    expect(
      resolveActiveFieldKey(
        Object.keys(properties),
        properties,
        objValue,
        [
          {
            label: "productClusterIds > 1211",
            itemIndex: 0,
            arrayLabel: "Selected Facets",
          },
        ],
        decofile,
      ),
    ).toBe("page");
  });

  test("two loaders carrying the same facet: bare crumb is ambiguous, ancestor crumb pins it", () => {
    // Real montecarlo SearchResult: `page` + `RangePriceProps` both carry a selectedFacets item labelled "category-1".
    const properties = {
      page: {
        title: "Page",
        type: "block-ref",
        anyOfRefs: [
          { resolveType: "vtex/loaders/productListingPage.ts", title: "PLP" },
        ],
      },
      RangePriceProps: {
        title: "Range Price Props",
        type: "block-ref",
        anyOfRefs: [
          {
            resolveType: "site/loaders/RangePriceData.ts",
            title: "Range Price",
          },
        ],
      },
    } satisfies Record<string, SchemaProperty>;
    const objValue = {
      page: {
        __resolveType: "vtex/loaders/productListingPage.ts",
        selectedFacets: [{ key: "category-1", value: "joias" }],
      },
      RangePriceProps: {
        __resolveType: "site/loaders/RangePriceData.ts",
        ProductListingPage: {
          selectedFacets: [{ key: "category-1", value: "joias" }],
        },
      },
    };
    const keys = Object.keys(properties);
    // Bare crumb → both own it → ambiguous → keep both siblings visible.
    expect(
      resolveActiveFieldKey(keys, properties, objValue, [
        { label: "category-1", itemIndex: 0 },
      ]),
    ).toBeNull();
    // The ancestor crumb (stamped by siblingsNeedingAncestorCrumb) pins the owner.
    expect(
      resolveActiveFieldKey(keys, properties, objValue, [
        "Page",
        { label: "category-1", itemIndex: 0 },
      ]),
    ).toBe("page");
    expect(
      resolveActiveFieldKey(keys, properties, objValue, [
        "Range Price Props",
        { label: "category-1", itemIndex: 0 },
      ]),
    ).toBe("RangePriceProps");
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
      buildArrayDrillDownBreadcrumb([], "Flag Desconto", "Partiu ferias", 0),
    ).toEqual([{ label: "Partiu ferias", itemIndex: 0 }]);
  });

  test("carries the array label on the item crumb when the item is labelled like the array", () => {
    // Item label == array label (e.g. label driven by `alt`): the array label
    // rides on the item crumb so breadcrumbPathForActiveField can still tell the
    // levels apart — without a separate, navigable "array list" crumb.
    expect(buildArrayDrillDownBreadcrumb([], "Banner", "Banner", 0)).toEqual([
      { label: "Banner", itemIndex: 0, arrayLabel: "Banner" },
    ]);
  });

  test("carries the array label on the item crumb when the item is labelled like the array KEY", () => {
    // Item label == array's property key: breadcrumbPathForActiveField strips a
    // head crumb matching the key too, so the array label must travel — as crumb
    // metadata, not a standalone stop.
    expect(
      buildArrayDrillDownBreadcrumb([], "Products", "items", 0, {
        arrayKey: "items",
      }),
    ).toEqual([
      {
        label: "items",
        itemIndex: 0,
        arrayLabel: "Products",
        fieldKey: "items",
      },
    ]);
  });

  test("carries the array label on the item crumb when a sibling drill-down field exists", () => {
    // A bare [itemLabel] trail can't say WHICH sibling array the item belongs to
    // (two label-less arrays both fall back to "Item N"), so the array label
    // rides on the item crumb as a disambiguator when siblings are present.
    expect(
      buildArrayDrillDownBreadcrumb([], "Logos", "Item 1", 0, {
        hasSiblingDrillDownFields: true,
      }),
    ).toEqual([{ label: "Item 1", itemIndex: 0, arrayLabel: "Logos" }]);
  });

  test("omits the array label when it is the sole drill-down field in scope", () => {
    expect(
      buildArrayDrillDownBreadcrumb([], "Images", "Item 1", 0, {
        arrayKey: "images",
        hasSiblingDrillDownFields: false,
      }),
    ).toEqual([{ label: "Item 1", itemIndex: 0, fieldKey: "images" }]);
  });

  test("never yields a standalone array-list navigation stop", () => {
    // The array label rides on the item crumb, never as its own crumb, so no
    // crumb renders as the bare array label — back from the item lands on the
    // array's parent form, not on a redundant "array list only" view.
    const trail = buildArrayDrillDownBreadcrumb([], "ProductTags", "Tag A", 2, {
      arrayKey: "productTags",
      hasSiblingDrillDownFields: true,
    });
    expect(trail).toHaveLength(1);
    expect(trail.map(crumbLabel)).not.toContain("ProductTags");
  });

  test("folds the array label when the item label is schema-only (titleBy)", () => {
    // titleBy labels can't be recomputed by a parent resolver, so the array label stays folded (invisible) as the disambiguator, even when it's the only array.
    expect(
      buildArrayDrillDownBreadcrumb([], "Selected Facets", "cat > 1", 0, {
        arrayKey: "selectedFacets",
        hasSiblingDrillDownFields: false,
        itemLabelFromSchema: true,
      }),
    ).toEqual([
      {
        label: "cat > 1",
        itemIndex: 0,
        arrayLabel: "Selected Facets",
        fieldKey: "selectedFacets",
      },
    ]);
  });

  test("does not duplicate crumbs already in trail", () => {
    expect(
      buildArrayDrillDownBreadcrumb(
        ["Flag Desconto", { label: "Partiu ferias", itemIndex: 0 }],
        "Flag Desconto",
        "Partiu ferias",
        0,
      ),
    ).toEqual(["Flag Desconto", { label: "Partiu ferias", itemIndex: 0 }]);
  });

  test("nested drill-down stays free of array labels (no doubled crumb)", () => {
    // Opening an item inside an already-open item appends only the new item
    // label — the intermediate array levels never enter the trail.
    expect(
      buildArrayDrillDownBreadcrumb(
        [{ label: "Leve 3 pague 2", itemIndex: 0 }],
        "Images",
        "Detroit",
        0,
      ),
    ).toEqual([
      { label: "Leve 3 pague 2", itemIndex: 0 },
      { label: "Detroit", itemIndex: 0 },
    ]);
  });
});

describe("sibling array disambiguation (regression)", () => {
  // Two sibling arrays of label-less objects: getArrayItemLabel falls back to
  // "Item N" for both, so a bare ["Item 1"] trail is ambiguous. The array label
  // must travel on the item crumb, and the correct array must resolve —
  // otherwise clicking one array's item opens the other (the wrong-array bug).
  const itemSchema = {
    type: "object",
    properties: { src: { type: "string", title: "Src" } },
  } as SchemaProperty;
  const properties = {
    images: { title: "Images", type: "array", items: itemSchema },
    logos: { title: "Logos", type: "array", items: itemSchema },
  } as Record<string, SchemaProperty>;
  const objValue = { images: [{ src: "a" }], logos: [{ src: "b" }] };

  test("carries array label on the crumb and resolves to the clicked array, not the first sibling", () => {
    const trail = buildArrayDrillDownBreadcrumb([], "Logos", "Item 1", 0, {
      arrayKey: "logos",
      hasSiblingDrillDownFields: true,
    });
    expect(trail).toEqual([
      { label: "Item 1", itemIndex: 0, arrayLabel: "Logos", fieldKey: "logos" },
    ]);
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
    const trail = buildArrayDrillDownBreadcrumb([], "Cards", "Men's", 0, {
      arrayKey: "cards",
      hasSiblingDrillDownFields: false,
    });
    expect(trail).toEqual([
      { label: "Men's", itemIndex: 0, fieldKey: "cards" },
    ]);
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

describe("structural fieldKey resolution", () => {
  const itemSchema = {
    type: "object",
    properties: { src: { type: "string" } },
  } as SchemaProperty;
  // Two sibling arrays sharing the SAME title AND identical item labels: neither the array label nor the item label can disambiguate — only the recorded fieldKey can.
  const properties = {
    a: { title: "Items", type: "array", items: itemSchema },
    b: { title: "Items", type: "array", items: itemSchema },
  } as Record<string, SchemaProperty>;
  const objValue = { a: [{ src: "x" }], b: [{ src: "x" }] };

  test("resolves the drilled array by fieldKey when title AND item label both collide", () => {
    const trail = buildArrayDrillDownBreadcrumb([], "Items", "Item 1", 0, {
      arrayKey: "b",
      hasSiblingDrillDownFields: true,
    });
    expect(
      resolveActiveFieldKey(
        Object.keys(properties),
        properties,
        objValue,
        trail,
      ),
    ).toBe("b");
  });

  test("a legacy crumb without fieldKey can't disambiguate and picks the first sibling", () => {
    const legacyTrail: Crumb[] = [
      { label: "Item 1", itemIndex: 0, arrayLabel: "Items" },
    ];
    expect(
      resolveActiveFieldKey(
        Object.keys(properties),
        properties,
        objValue,
        legacyTrail,
      ),
    ).toBe("a");
  });

  test("resolveArrayItemSelection pins by index via fieldKey despite a churned label", () => {
    const items = [{ name: "First" }, { name: "Second" }];
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
    } as SchemaProperty;
    const crumb: Crumb = {
      label: "STALE — being typed",
      itemIndex: 1,
      fieldKey: "cards",
    };
    const sel = resolveArrayItemSelection(
      "Cards",
      [crumb],
      items,
      schema,
      null,
      "cards",
    );
    expect(sel?.index).toBe(1);
  });

  test("resolveArrayItemSelection denies a sibling whose key differs from the crumb's fieldKey", () => {
    const items = [{ name: "First" }, { name: "Second" }];
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
    } as SchemaProperty;
    // Index 1 is in range and the label matches, but the crumb belongs to `cards`, not this array.
    const crumb: Crumb = { label: "Second", itemIndex: 1, fieldKey: "cards" };
    expect(
      resolveArrayItemSelection("Other", [crumb], items, schema, null, "other"),
    ).toBeNull();
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
        ["Options", "Cards", { label: "Men's", itemIndex: 0 }],
        items,
        itemSchema,
      ),
    ).toEqual({ index: 0, innerPath: [], crumbIndex: 2 });
  });

  test("returns inner path for nested array drill-down", () => {
    expect(
      resolveArrayItemSelection(
        "Cards",
        [{ label: "Men's", itemIndex: 0 }, "Sale"],
        items,
        itemSchema,
      ),
    ).toEqual({ index: 0, innerPath: ["Sale"], crumbIndex: 0 });
  });

  test("supports breadcrumb without array label", () => {
    expect(
      resolveArrayItemSelection(
        "Cards",
        [{ label: "Men's", itemIndex: 0 }, "Button"],
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
        [{ label: "Banner Sale", itemIndex: 0 }],
        bannerItems,
        bannerSchema,
        0,
      ),
    ).toEqual({ index: 0, innerPath: [], crumbIndex: 0 });
  });

  describe("duplicate labels", () => {
    // Two items share a base label ("Hello") — e.g. after Duplicate, or when an
    // object array has no distinguishing field so every row falls back to the
    // item schema title. The crumb carries the exact `itemIndex`, so each item
    // stays uniquely addressable even after a form remount clears the transient
    // open index — while the displayed label stays clean ("Hello", no number).
    const dupItems = [{ title: "Hello" }, { title: "Hello" }];

    test("addresses each duplicate by its item index (no preferredIndex)", () => {
      expect(
        resolveArrayItemSelection(
          "Cards",
          [{ label: "Hello", itemIndex: 0 }],
          dupItems,
          itemSchema,
        ),
      ).toEqual({ index: 0, innerPath: [], crumbIndex: 0 });
      expect(
        resolveArrayItemSelection(
          "Cards",
          [{ label: "Hello", itemIndex: 1 }],
          dupItems,
          itemSchema,
        ),
      ).toEqual({ index: 1, innerPath: [], crumbIndex: 0 });
    });

    test("a plain string crumb never resolves to an item", () => {
      // Item crumbs are objects carrying an index; a bare string is a
      // field/array label, so it must not silently resolve to the first item.
      expect(
        resolveArrayItemSelection("Cards", ["Hello"], dupItems, itemSchema),
      ).toBeNull();
    });

    test("the index pins the item even without a preferredIndex", () => {
      expect(
        resolveArrayItemSelection(
          "Cards",
          [{ label: "Hello", itemIndex: 1 }],
          dupItems,
          itemSchema,
        ),
      ).toEqual({ index: 1, innerPath: [], crumbIndex: 0 });
    });

    test("the index wins over a stale preferredIndex", () => {
      expect(
        resolveArrayItemSelection(
          "Cards",
          [{ label: "Women's", itemIndex: 1 }],
          items,
          itemSchema,
          0, // preferred item 0 is "Men's" — the crumb's index pins item 1
        ),
      ).toEqual({ index: 1, innerPath: [], crumbIndex: 0 });
    });

    test("resolves by index even when preferredIndex is out of range", () => {
      expect(
        resolveArrayItemSelection(
          "Cards",
          [{ label: "Hello", itemIndex: 1 }],
          dupItems,
          itemSchema,
          5,
        ),
      ).toEqual({ index: 1, innerPath: [], crumbIndex: 0 });
    });

    test("open-row pin: a stale crumb label sticks to the open row, not a colliding sibling", () => {
      /**
       * The crumb carries the OLD label ("Men's") because a deep re-sync hasn't
       * reached it, but items[1] already holds the edited value. A label search
       * would snap to the colliding sibling at index 0 (the bug); the open-row
       * pin (preferredIndex === itemIndex) keeps selection on 1.
       */
      const edited = [{ title: "Men's" }, { title: "Men's edited" }];
      expect(
        resolveArrayItemSelection(
          "Cards",
          [{ label: "Men's", itemIndex: 1 }],
          edited,
          itemSchema,
          1,
        ),
      ).toEqual({ index: 1, innerPath: [], crumbIndex: 0 });
    });

    test("open-row pin holds the last of three colliding items (label search would pick the first)", () => {
      /**
       * With three identical labels the last-resort search always returns 0, so
       * the index pin is the ONLY thing keeping selection on the edited row.
       */
      const triple = [{ title: "x" }, { title: "x" }, { title: "edited" }];
      expect(
        resolveArrayItemSelection(
          "Cards",
          [{ label: "x", itemIndex: 2 }],
          triple,
          itemSchema,
          2,
        ),
      ).toEqual({ index: 2, innerPath: [], crumbIndex: 0 });
    });

    test("open-row pin does NOT fire when preferredIndex differs from the crumb index", () => {
      /**
       * A genuine shift: the crumb's stale label still matches item 0, and the
       * open row (0) is not the crumb's index (1). The label match must win, so
       * selection lands on the real owner rather than blindly on the crumb index.
       */
      const shifted = [{ title: "A" }, { title: "B" }];
      expect(
        resolveArrayItemSelection(
          "Cards",
          [{ label: "A", itemIndex: 1 }],
          shifted,
          itemSchema,
          0,
        ),
      ).toEqual({ index: 0, innerPath: [], crumbIndex: 0 });
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
        ["Section", "Cards", { label: "Men's", itemIndex: 0 }, "Inner"],
        items,
        schema,
      ),
    ).toEqual({ index: 0, innerPath: ["Inner"], crumbIndex: 2 });
  });

  test("is the last crumb when innerPath is empty", () => {
    expect(
      resolveArrayItemSelection(
        "Cards",
        [{ label: "Women's", itemIndex: 1 }],
        items,
        schema,
      ),
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

  // Mirror ArrayField.updateItem's crumb re-sync exactly: the item's base label
  // (no siblings → no positional suffix) plus the stable `itemIndex`, rewritten
  // in place at `selection.crumbIndex` — spreading the existing crumb so a folded
  // `arrayLabel` disambiguator survives the label edit.
  const rewriteAndReresolve = (
    items: unknown[],
    trail: Crumb[],
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
    const oldLabel = getArrayItemLabel(items[openIndex], openIndex, schema);
    const newLabel = getArrayItemLabel(edited[openIndex], openIndex, schema);
    let nextTrail = trail;
    if (oldLabel !== newLabel) {
      nextTrail = [...trail];
      const existing = trail[selection.crumbIndex];
      nextTrail[selection.crumbIndex] =
        existing != null && typeof existing === "object"
          ? { ...existing, label: newLabel, itemIndex: openIndex }
          : { label: newLabel, itemIndex: openIndex };
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

  // Open the copy (index 1) by its crumb — carries the exact index.
  const openCrumb = (items: unknown[], index: number): Crumb => ({
    label: getArrayItemDisplayLabels(items, schema)[index]!,
    itemIndex: index,
  });

  test("editing the duplicate's title stays on the duplicate, not the original", () => {
    const items = [{ title: "Cozinha" }, { title: "Cozinha" }];
    const trail = [openCrumb(items, 1)];
    const edited = [{ title: "Cozinha" }, { title: "Cozinha Nova" }];
    expect(rewriteAndReresolve(items, trail, 1, edited).selection).toEqual({
      index: 1,
      innerPath: [],
      crumbIndex: 0,
    });
  });

  test("clearing the title mid-edit (label falls back) keeps the same item", () => {
    // Emptying the label field makes the row fall back to the "Item N" label;
    // the crumb still tracks it because the rewritten crumb keeps the index.
    const items = [{ title: "Cozinha" }, { title: "Cozinha" }];
    const trail = [openCrumb(items, 1)];
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
    const trail: Crumb[] = [{ label: "Cozinha", itemIndex: 0 }];
    const selection = resolveArrayItemSelection(
      "Banners",
      trail,
      items,
      withExtra,
      0,
    );
    const edited = [{ title: "Cozinha", href: "/b" }]; // label field unchanged
    const oldLabel = getArrayItemLabel(items[0], 0, withExtra);
    const newLabel = getArrayItemLabel(edited[0], 0, withExtra);
    expect(oldLabel).toBe(newLabel); // title drives the label; href doesn't
    // Trail stays as-is; re-resolving still lands on the item.
    expect(selection).toEqual({ index: 0, innerPath: [], crumbIndex: 0 });
  });

  test("editing an item drilled one level deep keeps the inner trail", () => {
    // Trail [item, Inner]: the item crumb is at position 0, so rewriting it
    // must leave the inner crumb ("Inner") untouched.
    const items = [{ title: "Cozinha" }, { title: "Cozinha" }];
    const trail: Crumb[] = [openCrumb(items, 1), "Inner"];
    const edited = [{ title: "Cozinha" }, { title: "Cozinha Nova" }];
    const { nextTrail, selection } = rewriteAndReresolve(
      items,
      trail,
      1,
      edited,
    );
    expect(nextTrail).toEqual([
      { label: "Cozinha Nova", itemIndex: 1 },
      "Inner",
    ]);
    expect(selection).toEqual({
      index: 1,
      innerPath: ["Inner"],
      crumbIndex: 0,
    });
  });

  test("editing the label preserves a folded arrayLabel disambiguator", () => {
    // updateItem spreads the existing crumb, so a label edit must not drop
    // `arrayLabel` — otherwise the item would re-resolve ambiguously across
    // same-shaped sibling arrays (the very thing the fold disambiguates).
    const items = [{ title: "Cozinha" }, { title: "Cozinha" }];
    const trail: Crumb[] = [
      { label: "Cozinha", itemIndex: 1, arrayLabel: "Banners" },
    ];
    const edited = [{ title: "Cozinha" }, { title: "Cozinha Nova" }];
    const { nextTrail, selection } = rewriteAndReresolve(
      items,
      trail,
      1,
      edited,
    );
    expect(nextTrail).toEqual([
      { label: "Cozinha Nova", itemIndex: 1, arrayLabel: "Banners" },
    ]);
    expect(selection).toEqual({ index: 1, innerPath: [], crumbIndex: 0 });
  });
});

describe("array item label build↔resolve round-trip", () => {
  // The fix's core promise: an item crumb (clean base label + itemIndex) must
  // resolve back to the same item with no transient state — this is what
  // survives a form remount. Exercises both seams together.
  const roundTrips = (items: unknown[], schema: SchemaProperty) => {
    const labels = getArrayItemDisplayLabels(items, schema);
    labels.forEach((label, i) => {
      expect(
        resolveArrayItemSelection(
          "Items",
          [{ label, itemIndex: i }],
          items,
          schema,
        ),
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

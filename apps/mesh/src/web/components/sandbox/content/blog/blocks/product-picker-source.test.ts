import { describe, expect, test } from "bun:test";
import {
  buildCategoryTreeRequest,
  buildProductRequests,
  buildProductsByIdsRequest,
  categoryOptionsFromPayload,
  categoryPathToFacets,
  filterCategoryOptions,
  PRODUCT_PICKER_COUNT,
  productOptionsFromPayload,
  VTEX_CATEGORY_TREE_RESOLVE_TYPE,
  VTEX_PRODUCT_LIST_RESOLVE_TYPE,
} from "./product-picker-source";

describe("categoryPathToFacets", () => {
  test("maps single segment to category-1", () => {
    expect(categoryPathToFacets("moda-feminina")).toBe(
      "category-1/moda-feminina",
    );
  });

  test("maps nested segments to numbered category facets", () => {
    expect(categoryPathToFacets("moda/calcados")).toBe(
      "category-1/moda/category-2/calcados",
    );
  });

  test("ignores surrounding and repeated slashes", () => {
    expect(categoryPathToFacets("/moda//calcados/")).toBe(
      "category-1/moda/category-2/calcados",
    );
  });

  test("returns empty string for empty path", () => {
    expect(categoryPathToFacets("")).toBe("");
  });
});

describe("buildProductRequests", () => {
  test("returns nothing for a blank term", () => {
    expect(buildProductRequests("search", "")).toEqual([]);
    expect(buildProductRequests("search", "   ")).toEqual([]);
    expect(buildProductRequests("cluster", "")).toEqual([]);
    expect(buildProductRequests("category", "")).toEqual([]);
  });

  test("search: plain text queries by name", () => {
    expect(buildProductRequests("search", "tênis")).toEqual([
      {
        resolveType: VTEX_PRODUCT_LIST_RESOLVE_TYPE,
        props: { query: "tênis", count: PRODUCT_PICKER_COUNT },
      },
    ]);
  });

  test("search: numeric term also tries exact SKU ids first", () => {
    expect(buildProductRequests("search", "151331")).toEqual([
      {
        resolveType: VTEX_PRODUCT_LIST_RESOLVE_TYPE,
        props: { ids: ["151331"] },
      },
      {
        resolveType: VTEX_PRODUCT_LIST_RESOLVE_TYPE,
        props: { query: "151331", count: PRODUCT_PICKER_COUNT },
      },
    ]);
  });

  test("search: slug-like term is de-hyphenated for the name query", () => {
    expect(buildProductRequests("search", "air-max-90")).toEqual([
      {
        resolveType: VTEX_PRODUCT_LIST_RESOLVE_TYPE,
        props: { query: "air max 90", count: PRODUCT_PICKER_COUNT },
      },
    ]);
  });

  test("cluster: passes collection id", () => {
    expect(buildProductRequests("cluster", "2140")).toEqual([
      {
        resolveType: VTEX_PRODUCT_LIST_RESOLVE_TYPE,
        props: { collection: "2140", count: PRODUCT_PICKER_COUNT },
      },
    ]);
  });

  test("category: converts the path to facets", () => {
    expect(buildProductRequests("category", "moda/calcados")).toEqual([
      {
        resolveType: VTEX_PRODUCT_LIST_RESOLVE_TYPE,
        props: {
          facets: "category-1/moda/category-2/calcados",
          count: PRODUCT_PICKER_COUNT,
        },
      },
    ]);
  });
});

describe("buildProductsByIdsRequest", () => {
  test("builds a productList request for the given ids", () => {
    expect(buildProductsByIdsRequest(["149524", "151294"])).toEqual({
      resolveType: VTEX_PRODUCT_LIST_RESOLVE_TYPE,
      props: { ids: ["149524", "151294"] },
    });
  });
});

describe("buildCategoryTreeRequest", () => {
  test("targets the VTEX category tree loader", () => {
    expect(buildCategoryTreeRequest()).toEqual({
      resolveType: VTEX_CATEGORY_TREE_RESOLVE_TYPE,
      props: {},
    });
  });
});

describe("productOptionsFromPayload", () => {
  test("maps a bare Product[] using productID as the stored id", () => {
    expect(
      productOptionsFromPayload([
        {
          productID: "151331",
          name: "Tênis Preto",
          isVariantOf: { name: "Tênis Corrida" },
          image: [{ url: "https://cdn/img.jpg" }],
        },
      ]),
    ).toEqual([
      {
        id: "151331",
        label: "Tênis Corrida",
        image: "https://cdn/img.jpg",
      },
    ]);
  });

  test("reads products from a ProductListingPage shape", () => {
    expect(
      productOptionsFromPayload({
        products: [{ productID: "1", name: "A" }],
      }),
    ).toEqual([{ id: "1", label: "A", image: undefined }]);
  });

  test("falls back to sku then id for the label", () => {
    expect(productOptionsFromPayload([{ sku: 42 }])).toEqual([
      { id: "42", label: "42", image: undefined },
    ]);
  });

  test("skips items with no id and dedupes by id", () => {
    expect(
      productOptionsFromPayload([
        { name: "no id" },
        { productID: "1", name: "First" },
        { productID: "1", name: "Dup" },
      ]),
    ).toEqual([{ id: "1", label: "First", image: undefined }]);
  });

  test("tolerates non-list payloads", () => {
    expect(productOptionsFromPayload(null)).toEqual([]);
    expect(productOptionsFromPayload({})).toEqual([]);
    expect(productOptionsFromPayload("nope")).toEqual([]);
  });
});

describe("categoryOptionsFromPayload", () => {
  const tree = [
    {
      name: "Moda",
      url: "https://store.com/moda",
      children: [
        {
          name: "Calçados",
          url: "https://store.com/moda/calcados",
          children: [],
        },
      ],
    },
  ];

  test("flattens the tree into breadcrumb-labelled paths", () => {
    expect(categoryOptionsFromPayload(tree)).toEqual([
      { path: "moda", label: "Moda" },
      { path: "moda/calcados", label: "Moda › Calçados" },
    ]);
  });

  test("returns empty for non-array payloads", () => {
    expect(categoryOptionsFromPayload(null)).toEqual([]);
    expect(categoryOptionsFromPayload({})).toEqual([]);
  });

  test("dedupes repeated paths", () => {
    expect(
      categoryOptionsFromPayload([
        { name: "A", url: "https://x/a" },
        { name: "A again", url: "https://x/a" },
      ]),
    ).toEqual([{ path: "a", label: "A" }]);
  });
});

describe("filterCategoryOptions", () => {
  const options = [
    { path: "moda", label: "Moda" },
    { path: "moda/calcados", label: "Moda › Calçados" },
    { path: "eletronicos", label: "Eletrônicos" },
  ];

  test("returns all when the term is blank", () => {
    expect(filterCategoryOptions(options, "")).toHaveLength(3);
  });

  test("matches label or path case-insensitively", () => {
    expect(filterCategoryOptions(options, "calc")).toEqual([
      { path: "moda/calcados", label: "Moda › Calçados" },
    ]);
    expect(filterCategoryOptions(options, "ELETR")).toEqual([
      { path: "eletronicos", label: "Eletrônicos" },
    ]);
  });

  test("caps the number of results", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      path: `c${i}`,
      label: `Cat ${i}`,
    }));
    expect(filterCategoryOptions(many, "", 10)).toHaveLength(10);
  });
});

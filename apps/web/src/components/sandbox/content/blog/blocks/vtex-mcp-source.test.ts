import { describe, expect, test } from "bun:test";
import {
  productOptionFromSku,
  productOptionsFromSearch,
  searchArgs,
  vtexMcpCatalogSource,
} from "./vtex-mcp-source";

const SEARCH = {
  products: [
    {
      productId: "200",
      productName: "Sofá Retrátil Aurora",
      linkText: "sofa-retratil-aurora",
      link: "/sofa-retratil-aurora/p",
      description: "<p>Três lugares, <b>linho</b>.</p>",
      categories: ["/Sala/Sofás/", "/Sala/"],
      items: [
        {
          itemId: "2001",
          name: "Cinza",
          images: [
            { imageUrl: "https://img.example/a.jpg" },
            { imageUrl: "https://img.example/b.jpg" },
            { imageUrl: "https://img.example/a.jpg" },
          ],
        },
        { itemId: "2002", name: "Bege", images: [] },
      ],
    },
    { productId: "300", productName: "Sem SKU", items: [] },
    {
      productId: "200",
      productName: "Duplicado",
      items: [{ itemId: "2001" }],
    },
  ],
};

describe("productOptionsFromSearch", () => {
  test("a product's first SKU stands for it, with that SKU's images", () => {
    expect(productOptionsFromSearch(SEARCH)).toEqual([
      {
        id: "2001",
        groupId: "200",
        label: "Sofá Retrátil Aurora",
        image: "https://img.example/a.jpg",
        images: ["https://img.example/a.jpg", "https://img.example/b.jpg"],
        url: "/sofa-retratil-aurora/p",
        category: "Sofás",
        description: "Três lugares, linho .",
      },
    ]);
  });

  test("anything else reads as no products", () => {
    expect(productOptionsFromSearch(null)).toEqual([]);
    expect(productOptionsFromSearch({ products: "x" })).toEqual([]);
  });

  test("falls back to the link text for an address", () => {
    const [option] = productOptionsFromSearch({
      products: [
        { productId: "1", linkText: "mesa", items: [{ itemId: "11" }] },
      ],
    });
    expect(option?.url).toBe("/mesa/p");
    expect(option?.label).toBe("11");
  });
});

describe("productOptionFromSku", () => {
  test("the catalog's SKU context, mapped", () => {
    expect(
      productOptionFromSku({
        Id: 2001,
        ProductId: 200,
        ProductName: "Sofá Retrátil Aurora",
        Images: [{ ImageUrl: "https://img.example/a.jpg" }],
        DetailUrl: "/sofa-retratil-aurora/p",
        ProductCategories: { "1": "Sala", "2": "Sofás" },
      }),
    ).toEqual({
      id: "2001",
      groupId: "200",
      label: "Sofá Retrátil Aurora",
      image: "https://img.example/a.jpg",
      images: ["https://img.example/a.jpg"],
      url: "/sofa-retratil-aurora/p",
      category: "Sofás",
      description: undefined,
    });
  });

  test("a miss is null", () => {
    expect(productOptionFromSku(null)).toBeNull();
    expect(productOptionFromSku({ ProductName: "no id" })).toBeNull();
  });
});

describe("searchArgs", () => {
  test("an empty search browses the catalog", () => {
    expect(searchArgs("search", "  ")).toEqual([{ facets: "/", count: 24 }]);
  });

  test("a number is also tried as a SKU id", () => {
    expect(searchArgs("search", "2001")).toEqual([
      { facets: "/", query: "sku.id:2001", count: 24 },
      { facets: "/", query: "2001", count: 24 },
    ]);
  });

  test("a category becomes its facets, a cluster its collection", () => {
    expect(searchArgs("category", "sala/sofas")).toEqual([
      { facets: "category-1/sala/category-2/sofas", count: 24 },
    ]);
    expect(searchArgs("cluster", "137")).toEqual([
      { facets: "productClusterIds/137", count: 24 },
    ]);
    expect(searchArgs("cluster", "")).toEqual([]);
    expect(searchArgs("category", "")).toEqual([]);
  });
});

describe("vtexMcpCatalogSource", () => {
  test("looks ids up one by one and drops the misses", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const source = vtexMcpCatalogSource("org/conn", async (name, args) => {
      calls.push([name, args]);
      if (args.skuId === "404") throw new Error("not found");
      return { Id: args.skuId, ProductName: `P${String(args.skuId)}` };
    });
    const found = await source.productsByIds(["1", "404", "2"]);
    expect(found.map((option) => option.id)).toEqual(["1", "2"]);
    expect(calls.every(([name]) => name === "VTEX_GET_SKU")).toBe(true);
  });

  test("merges a term's reads, deduped", async () => {
    const source = vtexMcpCatalogSource("org/conn", async () => SEARCH);
    const found = await source.searchProducts("search", "2001");
    expect(found.map((option) => option.id)).toEqual(["2001"]);
  });

  test("reads the category tree three levels deep", async () => {
    let asked: Record<string, unknown> | undefined;
    const source = vtexMcpCatalogSource("org/conn", async (_name, args) => {
      asked = args;
      return [
        {
          name: "Sala",
          url: "https://store.example/sala",
          children: [
            { name: "Sofás", url: "https://store.example/sala/sofas" },
          ],
        },
      ];
    });
    const tree = await source.categoryTree();
    expect(asked).toEqual({ categoryLevels: "3" });
    expect(tree.map((option) => option.label)).toEqual([
      "Sala",
      "Sala › Sofás",
    ]);
  });
});

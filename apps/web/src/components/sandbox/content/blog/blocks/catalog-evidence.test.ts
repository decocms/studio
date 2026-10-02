import { describe, expect, test } from "bun:test";
import { catalogProductLines, hasVtexCatalog } from "./catalog-evidence";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";

const metaWith = (loaders: string[]): LiveMeta => ({
  manifest: {
    blocks: {
      loaders: Object.fromEntries(loaders.map((rt) => [rt, {}])),
    },
  },
  schema: {},
});

describe("hasVtexCatalog", () => {
  test("true only when both allowlisted loaders ship", () => {
    expect(
      hasVtexCatalog(
        metaWith([
          "vtex/loaders/intelligentSearch/productList.ts",
          "vtex/loaders/categories/tree.ts",
        ]),
      ),
    ).toBe(true);
  });

  test("false when only one of the two ships — the proxy needs both", () => {
    expect(
      hasVtexCatalog(
        metaWith(["vtex/loaders/intelligentSearch/productList.ts"]),
      ),
    ).toBe(false);
  });

  test("false for a non-VTEX store, so it costs no round trip", () => {
    expect(hasVtexCatalog(metaWith(["shopify/loaders/ProductList.ts"]))).toBe(
      false,
    );
  });

  test("false for a site with no loaders at all", () => {
    expect(hasVtexCatalog(metaWith([]))).toBe(false);
  });
});

describe("catalogProductLines", () => {
  test("reads a ProductListingPage and a bare array alike", () => {
    const product = {
      productID: "1",
      name: "Vestido Midi",
      brand: { name: "Farm" },
      category: "Moda Feminina > Vestidos",
      offers: { lowPrice: 598 },
    };
    const expected = [
      "- Vestido Midi — Farm — 598.00 — Moda Feminina > Vestidos",
    ];
    expect(catalogProductLines({ products: [product] })).toEqual(expected);
    expect(catalogProductLines([product])).toEqual(expected);
  });

  test("prefers the variant name, the way the storefront titles a product", () => {
    expect(
      catalogProductLines([
        {
          productID: "1",
          name: "SKU 1",
          isVariantOf: { name: "Vestido Midi" },
        },
      ]),
    ).toEqual(["- Vestido Midi"]);
  });

  test("falls back to the first offer's price", () => {
    expect(
      catalogProductLines([
        {
          productID: "1",
          name: "Camisa",
          offers: { offers: [{ price: 199 }] },
        },
      ]),
    ).toEqual(["- Camisa — 199.00"]);
  });

  test("a missing field drops from the line, never the product", () => {
    expect(catalogProductLines([{ productID: "1", name: "Camisa" }])).toEqual([
      "- Camisa",
    ]);
  });

  test("dedupes by name — a shelf repeats the same product across facets", () => {
    expect(
      catalogProductLines([
        { productID: "1", name: "Camisa" },
        { productID: "2", name: "Camisa" },
      ]),
    ).toEqual(["- Camisa"]);
  });

  test("skips an entry with no name rather than emitting a bare dash", () => {
    expect(catalogProductLines([{ productID: "1" }, null, "nope"])).toEqual([]);
  });

  test("a payload that is not a catalog yields nothing", () => {
    expect(catalogProductLines(undefined)).toEqual([]);
    expect(catalogProductLines({ error: "403" })).toEqual([]);
  });
});

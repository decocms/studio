import { describe, expect, test } from "bun:test";
import { readProductListIds } from "./product-loader-utils";
import { readStringRef, readStringRefList } from "./product-string-utils";

const SPIRE_PRODUCT_CARD = {
  __resolveType: "blog/sections/blocks/ProductCard.tsx",
  product: "vtex:product:123",
  cta: "Comprar",
};

describe("app product string blocks (Spire / admin format)", () => {
  test("reads canonical string ref from Spire-authored ProductCard", () => {
    expect(readStringRef(SPIRE_PRODUCT_CARD.product)).toBe("vtex:product:123");
  });

  test("smoke: Spire string ref is visible to app editor, not loader-ref editor", () => {
    expect(readStringRef(SPIRE_PRODUCT_CARD.product)).toBe("vtex:product:123");
    expect(readProductListIds(SPIRE_PRODUCT_CARD.product)).toEqual([]);
  });

  test("save preserves string ref instead of rewriting to loader-ref", () => {
    const block = {
      __resolveType: "blog/sections/blocks/ProductCard.tsx",
      product: "vtex:product:123",
    };
    const saved = { ...block, product: "vtex:product:456" };
    expect(typeof saved.product).toBe("string");
    expect(saved.product).toBe("vtex:product:456");
    expect(saved.product).not.toMatch(/__resolveType/);
  });

  test("reads string[] refs from Spire-authored ProductShelf", () => {
    const block = {
      products: ["vtex:product:1", "vtex:product:2"],
    };
    expect(readStringRefList(block.products)).toEqual([
      "vtex:product:1",
      "vtex:product:2",
    ]);
  });

  test("does not misread loader-ref as string ref", () => {
    const loaderRef = {
      __resolveType: "vtex/loaders/intelligentSearch/productList.ts",
      props: { ids: ["123"] },
    };
    expect(readStringRef(loaderRef)).toBe("");
    expect(readStringRefList([loaderRef])).toEqual([""]);
  });
});

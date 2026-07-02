import { describe, expect, test } from "bun:test";
import {
  alignProductsToIds,
  parseProductListPreview,
  parseSingleProduct,
  productListLoaderKey,
} from "./product-preview-utils";

describe("parseSingleProduct", () => {
  test("reads schema.org product fields", () => {
    expect(
      parseSingleProduct({
        "@type": "Product",
        productID: "151331",
        sku: "151331",
        inProductGroupWithID: "149524",
        name: "Mala ABS",
        image: [
          { "@type": "ImageObject", url: "https://cdn.example/mala.jpg" },
        ],
      }),
    ).toEqual({
      id: "151331",
      sku: "151331",
      groupId: "149524",
      name: "Mala ABS",
      imageUrl: "https://cdn.example/mala.jpg",
    });
  });

  test("falls back to product group name", () => {
    expect(
      parseSingleProduct({
        sku: "999",
        inProductGroupWithID: "149524",
        isVariantOf: { name: "Group name" },
      }),
    ).toEqual({
      id: "999",
      sku: "999",
      groupId: "149524",
      name: "Group name",
      imageUrl: null,
    });
  });

  test("reads nested product.name from VTEX payloads", () => {
    expect(
      parseSingleProduct({
        sku: "149524",
        name: "0018592454003",
        product: {
          name: "Mala de Viagem ABS",
          image: [{ url: "https://cdn.example/mala.jpg" }],
        },
      }),
    ).toEqual({
      id: "149524",
      sku: "149524",
      groupId: "",
      name: "Mala de Viagem ABS",
      imageUrl: "https://cdn.example/mala.jpg",
    });
  });

  test("prefers isVariantOf.name over sku EAN in name", () => {
    expect(
      parseSingleProduct({
        productID: "149524",
        sku: "149524",
        inProductGroupWithID: "149524",
        name: "0018592454003",
        gtin: "0018592454003",
        isVariantOf: {
          name: "Mala ABS Rígida 4 Rodas",
          productGroupID: "149524",
        },
        image: [{ url: "https://cdn.example/mala.jpg" }],
      }),
    ).toEqual({
      id: "149524",
      sku: "149524",
      groupId: "149524",
      name: "Mala ABS Rígida 4 Rodas",
      imageUrl: "https://cdn.example/mala.jpg",
    });
  });
});

describe("parseProductListPreview", () => {
  test("parses a plain product array", () => {
    expect(
      parseProductListPreview([
        { productID: "1", sku: "1", name: "One" },
        { productID: "2", sku: "2", name: "Two" },
      ]),
    ).toEqual([
      { id: "1", sku: "1", groupId: "", name: "One", imageUrl: null },
      { id: "2", sku: "2", groupId: "", name: "Two", imageUrl: null },
    ]);
  });

  test("preserves sparse slots from VTEX sortProducts", () => {
    expect(
      parseProductListPreview([
        { sku: "149524", name: "A", image: ["https://cdn.example/a.jpg"] },
        undefined,
        null,
        {
          sku: "150522",
          name: "D",
          image: [{ url: "https://cdn.example/d.jpg" }],
        },
      ]),
    ).toEqual([
      {
        id: "149524",
        sku: "149524",
        groupId: "",
        name: "A",
        imageUrl: "https://cdn.example/a.jpg",
      },
      null,
      null,
      {
        id: "150522",
        sku: "150522",
        groupId: "",
        name: "D",
        imageUrl: "https://cdn.example/d.jpg",
      },
    ]);
  });
});

describe("alignProductsToIds", () => {
  test("matches by sku or product group id", () => {
    const products = [
      { id: "111", sku: "111", groupId: "149524", name: "A", imageUrl: null },
      { id: "222", sku: "222", groupId: "151294", name: "B", imageUrl: null },
    ];
    expect(alignProductsToIds(["149524", "151294"], products)).toEqual(
      products,
    );
  });

  test("uses positional slots when invoke preserves loader order", () => {
    const products = parseProductListPreview([
      { sku: "149524", name: "A", image: ["https://cdn.example/a.jpg"] },
      undefined,
      null,
      {
        sku: "150522",
        name: "D",
        image: [{ url: "https://cdn.example/d.jpg" }],
      },
    ]);
    expect(
      alignProductsToIds(["149524", "151294", "149526", "150522"], products),
    ).toEqual(products);
  });

  test("yields null slots for empty ids without shifting positional matches", () => {
    const productA = {
      id: "111",
      sku: "111",
      groupId: "",
      name: "A",
      imageUrl: null,
    };
    const productB = {
      id: "222",
      sku: "222",
      groupId: "",
      name: "B",
      imageUrl: null,
    };
    expect(
      alignProductsToIds(["2003481", "", "2003635"], [productA, productB]),
    ).toEqual([productA, null, productB]);
  });
});

describe("productListLoaderKey", () => {
  test("keys a list-loader by resolveType and ids", () => {
    expect(
      productListLoaderKey({
        __resolveType: "vtex/loaders/intelligentSearch/productList.ts",
        props: { ids: ["149524", "151294"] },
      }),
    ).toBe("vtex/loaders/intelligentSearch/productList.ts|149524,151294");
  });

  test("keys a ref-array by its item resolveTypes and ids", () => {
    expect(
      productListLoaderKey([
        {
          __resolveType: "site/loaders/customVTEX/productById.ts",
          productId: "2003481",
        },
        {
          __resolveType: "site/loaders/customVTEX/productById.ts",
          productId: "2003635",
        },
      ]),
    ).toBe("site/loaders/customVTEX/productById.ts|2003481,2003635");
  });
});

import { describe, expect, test } from "bun:test";
import {
  buildLoaderInvokeUrl,
  isValidLoaderResolveType,
  parseLoaderInvokeRequest,
} from "@/lib/loader-invoke";

describe("isValidLoaderResolveType", () => {
  test("rejects path traversal", () => {
    expect(isValidLoaderResolveType("vtex/../secret.ts")).toBe(false);
  });

  test("accepts standard loader paths", () => {
    expect(
      isValidLoaderResolveType("vtex/loaders/intelligentSearch/productList.ts"),
    ).toBe(true);
  });
});

describe("parseLoaderInvokeRequest", () => {
  test("returns null without __resolveType", () => {
    expect(parseLoaderInvokeRequest({ props: { ids: ["1"] } })).toBeNull();
  });

  test("rejects invalid resolveType", () => {
    expect(
      parseLoaderInvokeRequest({
        __resolveType: "../../_health",
        props: { ids: ["1"] },
      }),
    ).toBeNull();
  });

  test("maps block-ref to single invoke path payload", () => {
    expect(
      parseLoaderInvokeRequest({
        __resolveType: "vtex/loaders/intelligentSearch/productList.ts",
        props: { ids: ["149524"] },
      }),
    ).toEqual({
      resolveType: "vtex/loaders/intelligentSearch/productList.ts",
      payload: { props: { ids: ["149524"] } },
    });
  });

  test("uses spread payload when props key is absent", () => {
    expect(
      parseLoaderInvokeRequest({
        __resolveType: "vtex/loaders/intelligentSearch/productList.ts",
        ids: ["149524"],
      }),
    ).toEqual({
      resolveType: "vtex/loaders/intelligentSearch/productList.ts",
      payload: { ids: ["149524"] },
    });
  });
});

describe("buildLoaderInvokeUrl", () => {
  test("encodes resolveType in path", () => {
    expect(
      buildLoaderInvokeUrl(
        "https://preview.example.com/",
        "vtex/loaders/intelligentSearch/productList.ts",
      ),
    ).toBe(
      "https://preview.example.com/deco/invoke/vtex%2Floaders%2FintelligentSearch%2FproductList.ts",
    );
  });
});

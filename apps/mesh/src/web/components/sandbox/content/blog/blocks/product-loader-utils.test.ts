import { describe, expect, test } from "bun:test";
import {
  buildLoaderInvokeUrl,
  parseLoaderInvokeRequest,
  readProductListIds,
  toInvokeLoaderBody,
  writeProductListIds,
} from "./product-loader-utils";

describe("readProductListIds", () => {
  test("reads ids from vtex intelligentSearch loader", () => {
    expect(
      readProductListIds({
        __resolveType: "vtex/loaders/intelligentSearch/productList.ts",
        props: {
          ids: ["149524", "151294"],
          simulationBehavior: "default",
        },
      }),
    ).toEqual(["149524", "151294"]);
  });

  test("returns empty array for missing loader", () => {
    expect(readProductListIds(undefined)).toEqual([]);
    expect(readProductListIds({})).toEqual([]);
  });
});

describe("writeProductListIds", () => {
  test("preserves resolveType and simulationBehavior", () => {
    const loader = writeProductListIds(
      {
        __resolveType: "vtex/loaders/intelligentSearch/productList.ts",
        props: {
          ids: ["1"],
          simulationBehavior: "default",
        },
      },
      ["149524", "151294"],
    );

    expect(loader).toEqual({
      __resolveType: "vtex/loaders/intelligentSearch/productList.ts",
      props: {
        ids: ["149524", "151294"],
        simulationBehavior: "default",
      },
    });
  });

  test("creates default loader when missing", () => {
    expect(writeProductListIds(undefined, ["151331"])).toEqual({
      __resolveType: "vtex/loaders/intelligentSearch/productList.ts",
      props: {
        ids: ["151331"],
        simulationBehavior: "default",
      },
    });
  });
});

describe("toInvokeLoaderBody", () => {
  test("strips non-loader props before invoke", () => {
    expect(
      toInvokeLoaderBody({
        __resolveType: "vtex/loaders/intelligentSearch/productList.ts",
        props: {
          ids: ["149524", "151294"],
          simulationBehavior: "default",
        },
      }),
    ).toEqual({
      __resolveType: "vtex/loaders/intelligentSearch/productList.ts",
      props: { ids: ["149524", "151294"] },
    });
  });
});

describe("parseLoaderInvokeRequest", () => {
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
});

describe("buildLoaderInvokeUrl", () => {
  test("targets path-based invoke endpoint", () => {
    expect(
      buildLoaderInvokeUrl(
        "https://preview.example.com/",
        "vtex/loaders/intelligentSearch/productList.ts",
      ),
    ).toBe(
      "https://preview.example.com/deco/invoke/vtex/loaders/intelligentSearch/productList.ts",
    );
  });
});

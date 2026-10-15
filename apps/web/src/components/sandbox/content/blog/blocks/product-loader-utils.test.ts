import { describe, expect, test } from "bun:test";
import {
  readProductListIds,
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

  test("preserves empty entries so just-added rows stay visible", () => {
    expect(
      readProductListIds({
        __resolveType: "vtex/loaders/intelligentSearch/productList.ts",
        props: { ids: ["149524", ""] },
      }),
    ).toEqual(["149524", ""]);
  });

  test("reads ids from a ref-array of per-product loaders", () => {
    expect(
      readProductListIds([
        {
          __resolveType: "site/loaders/customVTEX/productById.ts",
          productId: "2003481",
        },
        {
          __resolveType: "site/loaders/customVTEX/productById.ts",
          productId: 2003635,
        },
      ]),
    ).toEqual(["2003481", "2003635"]);
  });

  test("reads the id from a single per-product loader ref", () => {
    expect(
      readProductListIds({
        __resolveType: "site/loaders/customVTEX/productById.ts",
        productId: "2003481",
      }),
    ).toEqual(["2003481"]);
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

  test("keeps the ref-array shape, reusing slots and cloning for new ids", () => {
    expect(
      writeProductListIds(
        [
          {
            __resolveType: "site/loaders/customVTEX/productById.ts",
            productId: "2003481",
          },
          {
            __resolveType: "site/loaders/customVTEX/productById.ts",
            productId: "2003635",
          },
        ],
        ["2003481", "999", ""],
      ),
    ).toEqual([
      {
        __resolveType: "site/loaders/customVTEX/productById.ts",
        productId: "2003481",
      },
      {
        __resolveType: "site/loaders/customVTEX/productById.ts",
        productId: "999",
      },
      {
        __resolveType: "site/loaders/customVTEX/productById.ts",
        productId: "",
      },
    ]);
  });

  test("keeps a single per-product ref's loader", () => {
    expect(
      writeProductListIds(
        {
          __resolveType: "site/loaders/customVTEX/productById.ts",
          productId: "2003481",
        },
        ["999"],
      ),
    ).toEqual({
      __resolveType: "site/loaders/customVTEX/productById.ts",
      productId: "999",
    });
  });

  test("falls back to the default list-loader for an empty array", () => {
    expect(writeProductListIds([], ["151331"])).toEqual({
      __resolveType: "vtex/loaders/intelligentSearch/productList.ts",
      props: {
        ids: ["151331"],
        simulationBehavior: "default",
      },
    });
  });
});

/**
 * A site whose section resolves the reference in its own loader stores the id
 * and nothing else. Read as empty, the editor showed a filled block as blank;
 * written back as a loader ref, it handed the site a shape its own component
 * cannot read — `typeof raw === "string"` fails and the card renders nothing.
 */
describe("plain references", () => {
  test("reads a bare id as the one product it is", () => {
    expect(readProductListIds("1948858")).toEqual(["1948858"]);
  });

  test("reads a list of bare ids", () => {
    expect(readProductListIds(["1948858", "1951207"])).toEqual([
      "1948858",
      "1951207",
    ]);
  });

  test("an empty reference holds no product", () => {
    expect(readProductListIds("")).toEqual([]);
  });

  test("keeps a bare id bare on write", () => {
    expect(writeProductListIds("1948858", ["999"])).toBe("999");
  });

  test("keeps a list of bare ids a list", () => {
    expect(writeProductListIds(["1948858"], ["111", "222"])).toEqual([
      "111",
      "222",
    ]);
  });

  test("clearing a bare reference leaves it empty, not a loader", () => {
    expect(writeProductListIds("1948858", [])).toBe("");
  });

  test("an array of refs is still an array of refs, not a list of ids", () => {
    const refs = [
      { __resolveType: "site/loaders/productById.ts", productId: "1" },
    ];
    expect(readProductListIds(refs)).toEqual(["1"]);
    expect(writeProductListIds(refs, ["2"])).toEqual([
      { __resolveType: "site/loaders/productById.ts", productId: "2" },
    ]);
  });
});

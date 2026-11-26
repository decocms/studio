import { describe, expect, test } from "bun:test";
import {
  readAvailability,
  type VtexCatalogSearchProduct,
  vtexSearchByProductIds,
} from "./vtex.ts";

const product = (
  sizes: Array<{ available?: boolean }>,
): VtexCatalogSearchProduct => ({
  productId: "1",
  productName: "p",
  items: sizes.map((s) => ({
    sellers: [
      {
        commertialOffer:
          s.available === undefined
            ? { AvailableQuantity: 10_000 }
            : { IsAvailable: s.available },
      },
    ],
  })),
});

describe("readAvailability", () => {
  test("counts sizes, not products", () => {
    expect(
      readAvailability(
        product([{ available: true }, { available: false }, {}]),
      ),
    ).toEqual({ totalSkus: 3, availableSkus: 1, state: "alive" });
  });

  test("every size gone is sold_out", () => {
    expect(readAvailability(product([{ available: false }])).state).toBe(
      "sold_out",
    );
  });

  test("a payload that never carried stock is unknown, not sold out", () => {
    expect(readAvailability(product([{}, {}])).state).toBe("unknown");
    expect(readAvailability(null).state).toBe("unknown");
  });
});

describe("vtexSearchByProductIds", () => {
  test("asks the store's public catalog for every id at once, without keys", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: new Headers(init?.headers) });
      return Response.json([]);
    }) as unknown as typeof fetch;
    await vtexSearchByProductIds(
      { publicHost: "loja.example" },
      ["1", "2", "1"],
      fake,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://loja.example/api/catalog_system/pub/products/search?fq=productId:1&fq=productId:2&_from=0&_to=1",
    );
    expect(calls[0]?.headers.get("X-VTEX-API-AppKey")).toBeNull();
  });

  test("no ids, no call", async () => {
    const fake = (async () => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch;
    expect(
      await vtexSearchByProductIds({ publicHost: "loja.example" }, [], fake),
    ).toEqual([]);
  });

  test("a 4xx fails at once with the status; a 503 is retried", async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      return n === 1
        ? new Response("busy", { status: 503 })
        : Response.json([{ productId: "1", productName: "p" }]);
    }) as unknown as typeof fetch;
    const out = await vtexSearchByProductIds(
      { publicHost: "loja.example" },
      ["1"],
      flaky,
    );
    expect(out.map((p) => p.productId)).toEqual(["1"]);
    expect(n).toBe(2);

    const missing = (async () =>
      new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(
      vtexSearchByProductIds({ publicHost: "loja.example" }, ["1"], missing),
    ).rejects.toThrow("HTTP 404");
  });
});

import { describe, expect, test } from "bun:test";
import { commerceRelayTarget, relayCommerceRead } from "./commerce-relay";

const IS =
  "https://nb.vtexcommercestable.com.br/api/io/_v/api/intelligent-search/product_search/?query=550";
const graphql = (query: string) =>
  `https://nb.vtexcommercestable.com.br/api/io/_v/private/graphql/v1?query=${encodeURIComponent(query)}`;

describe("commerceRelayTarget", () => {
  test.each([
    IS,
    "https://nb.vtexcommercestable.com.br/api/catalog_system/pub/products/search?fq=productId:1",
    "https://nb.myvtex.com/api/intelligent-search/v1/products?field=id&value=1",
    graphql(
      '{ product(identifier: { field: slug, value: "x" }) { productName } }',
    ),
  ])("allows %s", (url) => {
    expect(commerceRelayTarget(url)?.href).toBe(new URL(url).href);
  });

  test.each([
    ["missing", undefined],
    ["http", IS.replace("https:", "http:")],
    ["other host", "https://evil.test/api/catalog_system/pub/x"],
    [
      "lookalike host",
      "https://nb.vtexcommercestable.com.br.evil.test/api/catalog_system/pub/x",
    ],
    ["store domain", "https://www.example.com.br/api/catalog_system/pub/x"],
    [
      "port",
      "https://nb.vtexcommercestable.com.br:8443/api/catalog_system/pub/x",
    ],
    [
      "userinfo",
      "https://a:b@nb.vtexcommercestable.com.br/api/catalog_system/pub/x",
    ],
    [
      "checkout",
      "https://nb.vtexcommercestable.com.br/api/checkout/pub/orderForm",
    ],
    ["sessions", "https://nb.vtexcommercestable.com.br/api/sessions"],
    [
      "master data",
      "https://nb.vtexcommercestable.com.br/api/dataentities/CL/search",
    ],
    [
      "private catalog",
      "https://nb.vtexcommercestable.com.br/api/catalog/pvt/product/1",
    ],
    ["graphql mutation", graphql("mutation { addToCart { id } }")],
    [
      "graphql persisted",
      "https://nb.vtexcommercestable.com.br/api/io/_v/private/graphql/v1?extensions=x",
    ],
    ["too long", `${IS}&q=${"a".repeat(9000)}`],
  ])("refuses %s", (_label, url) => {
    expect(commerceRelayTarget(url)).toBeNull();
  });
});

describe("relayCommerceRead", () => {
  const upstream = (res: () => Response, seen: RequestInit[] = []) =>
    (async (_url: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return res();
    }) as unknown as typeof fetch;

  test("relays JSON with no upstream headers or credentials", async () => {
    const seen: RequestInit[] = [];
    const res = await relayCommerceRead(
      new URL(`${IS}&n=1`),
      upstream(
        () =>
          new Response('{"ok":true}', {
            headers: {
              "content-type": "application/json",
              "set-cookie": "a=1",
            },
          }),
        seen,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(seen[0]?.headers).toEqual({ accept: "application/json" });
    expect(seen[0]?.redirect).toBe("manual");
  });

  test("never passes HTML or redirects through", async () => {
    const html = await relayCommerceRead(
      new URL(`${IS}&n=2`),
      upstream(
        () =>
          new Response("<script>alert(1)</script>", {
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    expect(html.status).toBe(502);
    const redirect = await relayCommerceRead(
      new URL(`${IS}&n=3`),
      upstream(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.test/" },
          }),
      ),
    );
    expect(redirect.status).toBe(502);
  });

  test("caches a 200 for the same URL", async () => {
    let calls = 0;
    const fetchImpl = upstream(() => {
      calls++;
      return new Response("[]", {
        headers: { "content-type": "application/json" },
      });
    });
    const url = new URL(`${IS}&n=4`);
    await relayCommerceRead(url, fetchImpl);
    await relayCommerceRead(url, fetchImpl);
    expect(calls).toBe(1);
  });
});

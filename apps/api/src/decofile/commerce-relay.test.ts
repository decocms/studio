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
    [
      "encoded slash",
      "https://nb.vtexcommercestable.com.br/api/catalog_system/pub/..%2F..%2Fcheckout/pub/orderForm",
    ],
    [
      "encoded backslash",
      "https://nb.vtexcommercestable.com.br/api/catalog_system/pub/x%5Cy",
    ],
    [
      "encoded dot",
      "https://nb.vtexcommercestable.com.br/api/catalog_system/pub/%2E%2E/x",
    ],
    ["graphql extra param", `${graphql("{ a }")}&extensions=x`],
    ["graphql unknown param", `${graphql("{ a }")}&workspace=x`],
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

describe("commerceRelayTarget with the manifest's vtexAccount", () => {
  test("only that account", () => {
    expect(commerceRelayTarget(IS, "nb")).not.toBeNull();
    expect(
      commerceRelayTarget(IS.replace("//nb.", "//other."), "nb"),
    ).toBeNull();
    expect(commerceRelayTarget(IS.replace("//nb.", "//other."))).not.toBeNull();
  });

  test("graphql keeps query, variables and operationName", () => {
    expect(
      commerceRelayTarget(
        `${graphql("query P { a }")}&variables=%7B%7D&operationName=P`,
        "nb",
      ),
    ).not.toBeNull();
  });
});

describe("relay cache", () => {
  const json = (bytes: number) =>
    (async () =>
      new Response("x".repeat(bytes), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

  test("never caches a body above 256 KB", async () => {
    let calls = 0;
    const big = json(256 * 1024 + 1);
    const fetchImpl = ((...args: Parameters<typeof fetch>) => {
      calls++;
      return big(...args);
    }) as typeof fetch;
    const url = new URL(`${IS}&n=big`);
    await relayCommerceRead(url, fetchImpl);
    await relayCommerceRead(url, fetchImpl);
    expect(calls).toBe(2);
  });

  test("holds at most 32 MB, shedding the oldest", async () => {
    const seen: string[] = [];
    const body = json(256 * 1024);
    const fetchImpl = ((url: URL, init?: RequestInit) => {
      seen.push(url.href);
      return body(url, init);
    }) as typeof fetch;
    const urls = Array.from(
      { length: 129 },
      (_, i) => new URL(`${IS}&budget=${i}`),
    );
    for (const url of urls) await relayCommerceRead(url, fetchImpl);
    expect(seen.length).toBe(129);
    // 128 × 256 KB fit; the 129th pushed the first out.
    await relayCommerceRead(urls[128]!, fetchImpl);
    await relayCommerceRead(urls[1]!, fetchImpl);
    expect(seen.length).toBe(129);
    await relayCommerceRead(urls[0]!, fetchImpl);
    expect(seen.length).toBe(130);
  });
});

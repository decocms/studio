import { afterEach, describe, expect, test } from "bun:test";
import { makeProxyHandler } from "./proxy";

const noopBroadcaster = {
  broadcastChunk: () => {},
} as unknown as Parameters<typeof makeProxyHandler>[0]["broadcaster"];

let upstream: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  upstream?.stop(true);
  upstream = null;
});

describe("daemon proxy no-html fallback", () => {
  test("non-HTML at / → friendly 'no web page' HTML", async () => {
    upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const handler = makeProxyHandler({
      broadcaster: noopBroadcaster,
      getDevPort: () => upstream!.port ?? null,
    });
    const res = await handler(new Request("http://x.localhost/"));
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("No web page");
  });

  test("non-HTML at a sub-path passes through untouched", async () => {
    upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const handler = makeProxyHandler({
      broadcaster: noopBroadcaster,
      getDevPort: () => upstream!.port ?? null,
    });
    const res = await handler(new Request("http://x.localhost/api/data"));
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe('{"ok":true}');
  });

  test("HTML at / injects bootstrap and is NOT replaced", async () => {
    upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("<html><body></body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    const handler = makeProxyHandler({
      broadcaster: noopBroadcaster,
      getDevPort: () => upstream!.port ?? null,
    });
    const res = await handler(new Request("http://x.localhost/"));
    const body = await res.text();
    // The HTML-inject path must win over the no-web-page fallback.
    expect(body).not.toContain("No web page");
    expect(body).toContain("</body>");
  });
});

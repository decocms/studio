/**
 * Daemon conformance suite — REVERSE PROXY.
 *
 * The daemon proxies non-/health, non-/_sandbox requests to the dev server on
 * `getDevPort()` (sniffed port ?? application.port ?? null). We drive that port
 * via POST /config { application: { port } } and point it at an in-test
 * Bun.serve upstream (or a dead port) to exercise every proxy branch.
 */
import { afterEach, describe, expect, it } from "bun:test";

import {
  type Daemon,
  freePort,
  HOOK_TIMEOUT_MS,
  postConfig,
  startDaemon,
  stopDaemon,
  url,
} from "./daemon.e2e.helpers";

let d: Daemon | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;

afterEach(async () => {
  await stopDaemon(d);
  d = null;
  if (upstream) {
    upstream.stop(true);
    upstream = null;
  }
}, HOOK_TIMEOUT_MS);

/** Point the daemon's dev port at `port` (no listener required). */
async function setDevPort(daemon: Daemon, port: number): Promise<void> {
  const res = await postConfig(daemon, { application: { port } });
  expect(res.status).toBe(200);
}

async function startWithUpstream(
  handler: (req: Request) => Response | Promise<Response>,
): Promise<void> {
  upstream = Bun.serve({ port: 0, fetch: handler });
  d = await startDaemon();
  await setDevPort(d, upstream.port as number);
}

async function startWithDeadPort(): Promise<void> {
  d = await startDaemon();
  await setDevPort(d, await freePort()); // nothing is listening there
}

describe("daemon e2e: reverse proxy", () => {
  it("no dev port configured → 503 'No dev server running'", async () => {
    d = await startDaemon();
    const res = await fetch(url(d, "/"));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.text()).toContain("No dev server running");
  });

  it("dev port set but unreachable at / → 503 'Server is starting…' + Retry-After", async () => {
    await startWithDeadPort();
    const res = await fetch(url(d!, "/"));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("retry-after")).toBe("1");
    expect(await res.text()).toContain("Server is starting");
  });

  it("dev port set but unreachable at a non-root asset request → 502 JSON", async () => {
    await startWithDeadPort();
    const res = await fetch(url(d!, "/api/thing"));
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("proxy error");
  });

  it("dev port set but unreachable at a non-root navigation → 503 'Server is starting…'", async () => {
    // Shared preview links carry a deep path. Before this, only `/` got the
    // starting page and every other URL 502'd through the boot window.
    await startWithDeadPort();
    const res = await fetch(url(d!, "/2127?map=productClusterIds"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("retry-after")).toBe("1");
    expect(await res.text()).toContain("Server is starting");
  });

  it("HTML upstream: injects bootstrap + strips XFO/CSP", async () => {
    await startWithUpstream(
      () =>
        new Response("<html><body><h1>hi</h1></body></html>", {
          headers: {
            "Content-Type": "text/html",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'none'",
          },
        }),
    );
    const res = await fetch(url(d!, "/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBeNull();
    const body = await res.text();
    expect(body).toContain("<script");
    expect(body.indexOf("<script")).toBeLessThan(body.lastIndexOf("</body>"));
  });

  it("non-HTML at / → 200 'No web page at this URL'", async () => {
    await startWithUpstream(() => Response.json({ ok: true }));
    const res = await fetch(url(d!, "/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toContain("No web page at this URL");
  });

  it("error status at / passes through instead of the 'No web page' page", async () => {
    // Vite's 403 for an unknown Host is a refusal, not "this isn't a web app".
    await startWithUpstream(
      () =>
        new Response("Blocked request. This host is not allowed.", {
          status: 403,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const res = await fetch(url(d!, "/"));
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain("Blocked request");
    expect(body).not.toContain("No web page at this URL");
  });

  it("304 at / passes through instead of the 'No web page' page", async () => {
    // A cache revalidation of an HTML page: 304 carries no Content-Type.
    await startWithUpstream((req) => {
      expect(req.headers.get("if-none-match")).toBe('"abc"');
      return new Response(null, { status: 304, headers: { ETag: '"abc"' } });
    });
    const res = await fetch(url(d!, "/"), {
      headers: { "If-None-Match": '"abc"' },
    });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"abc"');
    expect(await res.text()).not.toContain("No web page at this URL");
  });

  it("302 at / passes through with its Location instead of the 'No web page' page", async () => {
    await startWithUpstream(
      () => new Response(null, { status: 302, headers: { Location: "/app" } }),
    );
    const res = await fetch(url(d!, "/"), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app");
    expect(await res.text()).not.toContain("No web page at this URL");
  });

  it("non-root pass-through strips X-Frame-Options and forwards the body", async () => {
    let receivedBody = "";
    await startWithUpstream(async (req) => {
      receivedBody = await req.text();
      return Response.json(
        { ok: true },
        { headers: { "X-Frame-Options": "DENY" } },
      );
    });
    const res = await fetch(url(d!, "/api/echo"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(receivedBody).toBe('{"hello":"world"}');
  });

  it("strips Authorization from the request the dev server sees", async () => {
    let seenAuth: string | null = "<<unset>>";
    await startWithUpstream((req) => {
      seenAuth = req.headers.get("authorization");
      return Response.json({ ok: true });
    });
    const res = await fetch(url(d!, "/api/sniff"), {
      headers: { Authorization: "Bearer should-be-stripped" },
    });
    expect(res.status).toBe(200);
    expect(seenAuth).toBeNull();
  });

  it("keeps an editor entry and its plain relative navigation private after dev-server headers", async () => {
    await startWithUpstream(
      () =>
        new Response(
          '<html><body><h1>Draft</h1><a href="/catalog">Catalog</a></body></html>',
          {
            headers: {
              "Content-Type": "text/html",
              "Cache-Control": "no-cache, must-revalidate",
            },
          },
        ),
    );
    const responses = [];
    for (const path of ["/?__decoFBT=0&__deco_ssr=1", "/catalog"]) {
      const response = await fetch(url(d!, path));
      const body = await response.text();
      responses.push(response.headers.get("cache-control"));
      expect(response.status).toBe(200);
      expect(body).toContain("<h1>Draft</h1>");
      expect(body).toContain('href="/catalog"');
      expect(body).toContain("<script");
    }
    expect(responses).toEqual(["private, no-store", "private, no-store"]);
  });

  const representations = [
    {
      name: "HTML",
      path: "/page",
      status: 200,
      type: "text/html",
      body: "<html><body>Preview</body></html>",
      cache: "no-cache, must-revalidate",
    },
    {
      name: "Flight",
      path: "/page?_rsc=owned",
      status: 200,
      type: "text/x-component",
      body: '0:{"preview":true}\n',
      cache: "public, max-age=600",
    },
    {
      name: "JSON",
      path: "/api/data",
      status: 200,
      type: "application/json",
      body: '{"preview":true}',
      cache: "public, max-age=600",
    },
    {
      name: "redirect",
      path: "/redirect",
      status: 307,
      type: "text/plain",
      body: "Redirecting",
      cache: "public, max-age=600",
      location: "/page?from=preview",
    },
    {
      name: "HTML error",
      path: "/error",
      status: 503,
      type: "text/html",
      body: "<html><body>Unavailable</body></html>",
      cache: "public, max-age=600",
    },
    {
      name: "JSON error",
      path: "/api/missing",
      status: 404,
      type: "application/json",
      body: '{"error":"missing"}',
      cache: "public, max-age=600",
    },
    {
      name: "conditional response",
      path: "/page",
      status: 304,
      type: "text/plain",
      body: null,
      cache: "public, max-age=600",
    },
    {
      name: "empty response",
      path: "/api/empty",
      status: 204,
      type: "text/plain",
      body: null,
      cache: "public, max-age=600",
    },
    {
      name: "immutable JavaScript",
      path: "/assets/owned.0123456789abcdef.js",
      status: 200,
      type: "text/javascript",
      body: "export const preview = true;",
      cache: "public, max-age=31536000, immutable",
    },
    {
      name: "immutable CSS",
      path: "/assets/owned.0123456789abcdef.css",
      status: 200,
      type: "text/css",
      body: "body { color: red; }",
      cache: "public, max-age=31536000, immutable",
    },
    {
      name: "unclassified asset",
      path: "/assets/data.bin",
      status: 200,
      type: "application/octet-stream",
      body: "preview bytes",
      cache: null,
    },
    {
      name: "HEAD",
      path: "/assets/head.txt",
      status: 200,
      type: "text/plain",
      body: "preview",
      cache: "public, max-age=600",
      method: "HEAD",
    },
  ];

  for (const representation of representations) {
    it(`normalizes ${representation.name} caching without changing the upstream HTTP contract`, async () => {
      const cookies = [
        "preview-session=synthetic; HttpOnly",
        "preview-state=owned; SameSite=Lax",
      ];
      await startWithUpstream(() => {
        const headers = new Headers({
          "Content-Type": representation.type,
          Vary: "Cookie, rsc",
          ETag: '"owned-version"',
        });
        if (representation.cache)
          headers.set("Cache-Control", representation.cache);
        if (representation.location)
          headers.set("Location", representation.location);
        for (const cookie of cookies) headers.append("Set-Cookie", cookie);
        return new Response(representation.body, {
          status: representation.status,
          headers,
        });
      });
      const response = await fetch(url(d!, representation.path), {
        method: representation.method ?? "GET",
        redirect: "manual",
        headers:
          representation.status === 304
            ? { "If-None-Match": '"owned-version"' }
            : undefined,
      });
      const body = await response.text();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.status).toBe(representation.status);
      expect(response.headers.get("location")).toBe(
        representation.location ?? null,
      );
      expect(response.headers.get("vary")).toBe("Cookie, rsc");
      expect(response.headers.get("etag")).toBe('"owned-version"');
      expect(response.headers.getSetCookie()).toEqual(cookies);
      if (representation.type === "text/html") {
        expect(body.startsWith(representation.body!.split("</body>")[0]!)).toBe(
          true,
        );
        expect(body.endsWith("</body></html>")).toBe(true);
        expect(body).toContain("<script");
      } else {
        expect(body).toBe(
          representation.method === "HEAD" ? "" : (representation.body ?? ""),
        );
      }
    });
  }
});

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
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.text()).toContain("No dev server running");
  });

  it("dev port set but unreachable at / → 503 'Server is starting…' + Retry-After", async () => {
    await startWithDeadPort();
    const res = await fetch(url(d!, "/"));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(await res.text()).toContain("Server is starting");
  });

  it("dev port set but unreachable at a non-root asset request → 502 JSON", async () => {
    await startWithDeadPort();
    const res = await fetch(url(d!, "/api/thing"));
    expect(res.status).toBe(502);
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
});

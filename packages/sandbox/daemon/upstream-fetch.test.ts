import { describe, expect, test } from "bun:test";
import { fetchLoopback } from "./upstream-fetch";

async function withServer(
  hostname: string,
  handler: (req: Request) => Response,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ port: 0, hostname, fetch: handler });
  try {
    await fn(server.port);
  } finally {
    server.stop(true);
  }
}

describe("fetchLoopback", () => {
  test("reaches an IPv6-only server (Bun's default for `localhost`)", async () => {
    await withServer(
      "::1",
      () => new Response("v6-ok"),
      async (port) => {
        const res = await fetchLoopback(port, "/");
        expect(await res.text()).toBe("v6-ok");
      },
    );
  });

  test("falls back to IPv4 when nothing listens on [::1]", async () => {
    await withServer(
      "127.0.0.1",
      () => new Response("v4-ok"),
      async (port) => {
        const res = await fetchLoopback(port, "/");
        expect(await res.text()).toBe("v4-ok");
      },
    );
  });

  test("forwards path and query", async () => {
    await withServer(
      "::1",
      (req) => {
        const url = new URL(req.url);
        return new Response(`${url.pathname}${url.search}`);
      },
      async (port) => {
        const res = await fetchLoopback(port, "/foo/bar?x=1");
        expect(await res.text()).toBe("/foo/bar?x=1");
      },
    );
  });

  test("forwards method and body via init", async () => {
    await withServer(
      "::1",
      async (req) => new Response(`${req.method}:${await req.text()}`),
      async (port) => {
        const res = await fetchLoopback(port, "/", {
          method: "POST",
          body: "payload",
        });
        expect(await res.text()).toBe("POST:payload");
      },
    );
  });

  test("throws when nothing listens on either address", async () => {
    // Pick a port unlikely to have anything; if collision flakes the test,
    // a higher random pick reduces the odds.
    const port = 49000 + Math.floor(Math.random() * 10000);
    await expect(fetchLoopback(port, "/")).rejects.toThrow();
  });

  test("does not retry after a non-connection-refused failure", async () => {
    // [::1] accepts the connection but aborts mid-request. Without the
    // connection-refused gate, the catch would resend the body to 127.0.0.1
    // — which here serves a DIFFERENT response, exposing the retry.
    let v4Hits = 0;
    const v6 = Bun.serve({
      port: 0,
      hostname: "::1",
      fetch: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return new Response("v6");
      },
    });
    const v4 = Bun.serve({
      port: v6.port,
      hostname: "127.0.0.1",
      fetch: () => {
        v4Hits++;
        return new Response("v4");
      },
    });
    try {
      const ctrl = new AbortController();
      const promise = fetchLoopback(v6.port, "/", { signal: ctrl.signal });
      // Give the request time to reach v6 before aborting, so the failure is
      // mid-flight (AbortError) and not a pre-flight connection error.
      await new Promise((r) => setTimeout(r, 30));
      ctrl.abort();
      await expect(promise).rejects.toThrow();
      expect(v4Hits).toBe(0);
    } finally {
      v6.stop(true);
      v4.stop(true);
    }
  });
});

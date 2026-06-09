import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { probeDaemonHealth, proxyDaemonRequest } from "./daemon-client";

type FetchCall = {
  input: string;
  init: RequestInit & { duplex?: string };
};

// Minimal fetch harness: stash calls + let each test control the response.
function installFetch(
  responder: (call: FetchCall) => Promise<Response> | Response,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
    const call: FetchCall = {
      input: String(input),
      init: (init ?? {}) as RequestInit & { duplex?: string },
    };
    calls.push(call);
    return await responder(call);
  }) as unknown as typeof fetch;
  return { calls };
}

let origFetch: typeof fetch;

beforeEach(() => {
  origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("probeDaemonHealth", () => {
  it("returns DaemonHealth when fetch resolves with valid shape", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            ready: true,
            bootId: "boot-123",
            configured: true,
            setup: { running: false, done: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await probeDaemonHealth("http://daemon:9000");
    expect(result).toEqual({
      ready: true,
      bootId: "boot-123",
      configured: true,
      setup: { running: false, done: true },
    });
  });

  it("returns null when fetch rejects (network error)", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(await probeDaemonHealth("http://daemon:9000")).toBeNull();
  });

  it("returns null when fetch resolves with ok=false", async () => {
    installFetch(() => new Response("boom", { status: 500 }));
    expect(await probeDaemonHealth("http://daemon:9000")).toBeNull();
  });

  it("returns null when response body lacks bootId", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            ready: true,
            setup: { running: false, done: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    expect(await probeDaemonHealth("http://daemon:9000")).toBeNull();
  });

  it("returns null when response body has wrong shape", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(await probeDaemonHealth("http://daemon:9000")).toBeNull();
  });
});

describe("proxyDaemonRequest", () => {
  it("injects Authorization: Bearer <token> header", async () => {
    const { calls } = installFetch(() => new Response("", { status: 204 }));
    await proxyDaemonRequest("http://d", "tok-xyz", "/_daemon/ping", {
      method: "GET",
      headers: new Headers(),
      body: null,
    });
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer tok-xyz");
  });

  const STRIP = [
    "cookie",
    "host",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "accept-encoding",
    "content-length",
  ];

  for (const hdr of STRIP) {
    it(`strips forbidden request header: ${hdr}`, async () => {
      const { calls } = installFetch(() => new Response("", { status: 204 }));
      const h = new Headers();
      h.set(hdr, "something");
      h.set("x-keep", "kept");
      await proxyDaemonRequest("http://d", "t", "/p", {
        method: "GET",
        headers: h,
        body: null,
      });
      const sent = new Headers(calls[0]!.init.headers as HeadersInit);
      expect(sent.get(hdr)).toBeNull();
      expect(sent.get("x-keep")).toBe("kept");
    });
  }

  it("does not forward body for GET", async () => {
    const { calls } = installFetch(() => new Response("", { status: 204 }));
    await proxyDaemonRequest("http://d", "t", "/p", {
      method: "GET",
      headers: new Headers(),
      body: "should-not-forward",
    });
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("does not forward body for HEAD", async () => {
    const { calls } = installFetch(() => new Response("", { status: 204 }));
    await proxyDaemonRequest("http://d", "t", "/p", {
      method: "HEAD",
      headers: new Headers(),
      body: "should-not-forward",
    });
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("forwards body for POST", async () => {
    const { calls } = installFetch(() => new Response("", { status: 204 }));
    await proxyDaemonRequest("http://d", "t", "/p", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: '{"a":1}',
    });
    expect(calls[0]!.init.body).toBe('{"a":1}');
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("prepends '/' to relative paths without a leading slash", async () => {
    const { calls } = installFetch(() => new Response("", { status: 204 }));
    await proxyDaemonRequest("http://daemon:9000", "t", "some/path", {
      method: "GET",
      headers: new Headers(),
      body: null,
    });
    expect(calls[0]!.input).toBe("http://daemon:9000/some/path");
  });

  it("keeps absolute paths with a leading slash as-is", async () => {
    const { calls } = installFetch(() => new Response("", { status: 204 }));
    await proxyDaemonRequest("http://daemon:9000", "t", "/already/abs", {
      method: "GET",
      headers: new Headers(),
      body: null,
    });
    expect(calls[0]!.input).toBe("http://daemon:9000/already/abs");
  });
});

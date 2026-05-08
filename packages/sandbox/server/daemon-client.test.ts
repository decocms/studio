import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  daemonBash,
  probeDaemonHealth,
  proxyDaemonRequest,
} from "./daemon-client";

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

describe("daemonBash", () => {
  it("sends POST to {daemonUrl}/_decopilot_vm/bash with auth and base64 JSON body", async () => {
    const { calls } = installFetch(
      () =>
        new Response(
          JSON.stringify({
            stdout: "hi",
            stderr: "",
            exitCode: 0,
            timedOut: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await daemonBash("http://daemon:9000", "tok-123", {
      command: "echo hi",
      cwd: "/work",
      env: { A: "1" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe("http://daemon:9000/_decopilot_vm/bash");
    expect(calls[0]!.init.method).toBe("POST");

    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer tok-123");
    expect(headers.get("content-type")).toBe("application/json");

    const b64Body = String(calls[0]!.init.body);
    const rawBody = Buffer.from(b64Body, "base64").toString("utf-8");
    const body = JSON.parse(rawBody);
    expect(body.command).toBe("echo hi");
    expect(body.cwd).toBe("/work");
    expect(body.env).toEqual({ A: "1" });
    expect(typeof body.timeout).toBe("number");
  });

  it("parses { stdout, stderr, exitCode, timedOut } on 200", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            stdout: "out",
            stderr: "err",
            exitCode: 2,
            timedOut: true,
          }),
          { status: 200 },
        ),
    );

    const out = await daemonBash("http://d", "t", { command: "x" });
    expect(out).toEqual({
      stdout: "out",
      stderr: "err",
      exitCode: 2,
      timedOut: true,
    });
  });

  it("throws an Error containing status code when response not ok", async () => {
    installFetch(() => new Response("nope", { status: 502 }));

    await expect(daemonBash("http://d", "t", { command: "x" })).rejects.toThrow(
      /502/,
    );
  });

  it("uses default 60_000ms timeout when input.timeoutMs not provided", async () => {
    const { calls } = installFetch(
      () =>
        new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), {
          status: 200,
        }),
    );
    await daemonBash("http://d", "t", { command: "x" });
    const b64Body = String(calls[0]!.init.body);
    const rawBody = Buffer.from(b64Body, "base64").toString("utf-8");
    const body = JSON.parse(rawBody);
    expect(body.timeout).toBe(60_000);
    // AbortSignal must be present too (timeoutMs + 5_000 wired via AbortSignal.timeout).
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses provided timeoutMs in body and passes an AbortSignal", async () => {
    const { calls } = installFetch(
      () =>
        new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), {
          status: 200,
        }),
    );
    await daemonBash("http://d", "t", { command: "x", timeoutMs: 12_000 });
    const b64Body = String(calls[0]!.init.body);
    const rawBody = Buffer.from(b64Body, "base64").toString("utf-8");
    const body = JSON.parse(rawBody);
    expect(body.timeout).toBe(12_000);
    // The implementation composes AbortSignal.timeout(timeoutMs + 5_000);
    // we can't read the numeric deadline back, but we can at least confirm a
    // signal was attached (the module is the only source of it).
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("defaults missing fields in the response (stdout/stderr='', exitCode=-1)", async () => {
    installFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    const out = await daemonBash("http://d", "t", { command: "x" });
    expect(out).toEqual({
      stdout: "",
      stderr: "",
      exitCode: -1,
      timedOut: false,
    });
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

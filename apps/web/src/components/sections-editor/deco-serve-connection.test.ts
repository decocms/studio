import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ContentProtocolError, ErrorCode } from "@decocms/blocks/protocol";
import {
  classifyServeProbeError,
  clearLastConnection,
  DEFAULT_SERVE_ENDPOINT,
  discoveryCandidates,
  markDisconnected,
  NotDecoServeError,
  parseServeAddress,
  readDisconnected,
  serveCommand,
  unmarkDisconnected,
  endpointHost,
  isLoopbackEndpoint,
  parseConnectFragment,
  parseConnectLink,
  parseStoredConnection,
  probeRetryDelay,
  readLastConnection,
  saveLastConnection,
} from "./deco-serve-connection";

describe("parseConnectFragment", () => {
  test("reads the endpoint deco serve prints", () => {
    expect(
      parseConnectFragment(
        `#endpoint=${encodeURIComponent("http://127.0.0.1:4545/rpc")}`,
      ),
    ).toEqual({ endpoint: "http://127.0.0.1:4545/rpc" });
  });

  test("ignores a token left in an older link", () => {
    expect(
      parseConnectFragment(
        `#endpoint=${encodeURIComponent("http://127.0.0.1:4545/rpc")}&token=abc123`,
      ),
    ).toEqual({ endpoint: "http://127.0.0.1:4545/rpc" });
  });

  test("refuses incomplete or unsafe links", () => {
    expect(parseConnectFragment("")).toBeNull();
    expect(parseConnectFragment("#token=abc")).toBeNull();
    expect(parseConnectFragment("#endpoint=javascript:alert(1)")).toBeNull();
    expect(parseConnectFragment("#endpoint=not a url")).toBeNull();
    expect(
      parseConnectFragment(`#endpoint=http://127.0.0.1/${"x".repeat(2100)}`),
    ).toBeNull();
  });
});

describe("isLoopbackEndpoint", () => {
  test("accepts only this machine", () => {
    for (const endpoint of [
      "http://127.0.0.1:4545/rpc",
      "http://localhost:4545/rpc",
      "http://[::1]:4545/rpc",
    ]) {
      expect(isLoopbackEndpoint(endpoint)).toBe(true);
    }
    for (const endpoint of [
      "https://evil.example/rpc",
      "http://127.0.0.1.evil.example/rpc",
      "http://localhost.evil.example/rpc",
      "https://site.localhost/rpc",
      "http://10.0.0.2:4545/rpc",
      "ftp://127.0.0.1/rpc",
      "not a url",
    ]) {
      expect(isLoopbackEndpoint(endpoint)).toBe(false);
    }
  });

  test("a connect link to another path is refused", () => {
    expect(
      parseConnectFragment("#endpoint=http://127.0.0.1:4545/other"),
    ).toBeNull();
    expect(parseConnectFragment("#endpoint=http://127.0.0.1:4545/rpc")).toEqual(
      { endpoint: "http://127.0.0.1:4545/rpc" },
    );
  });

  test("a connect link to another host is refused", () => {
    expect(
      parseConnectFragment("#endpoint=https://evil.example/rpc"),
    ).toBeNull();
  });
});

describe("parseStoredConnection", () => {
  test("accepts only a well-formed connection", () => {
    expect(
      parseStoredConnection({ endpoint: "http://127.0.0.1:1/rpc" }),
    ).toEqual({ endpoint: "http://127.0.0.1:1/rpc" });
    expect(parseStoredConnection(null)).toBeNull();
    expect(parseStoredConnection("http://127.0.0.1:1/rpc")).toBeNull();
    expect(parseStoredConnection({ endpoint: "x" })).toBeNull();
  });

  test("drops the token an older Studio stored", () => {
    expect(
      parseStoredConnection({ endpoint: "http://127.0.0.1:1/rpc", token: "t" }),
    ).toEqual({ endpoint: "http://127.0.0.1:1/rpc" });
  });
});

describe("parseConnectLink", () => {
  const endpoint = encodeURIComponent("http://127.0.0.1:4545/rpc");

  test("reads a pasted site editor link", () => {
    expect(
      parseConnectLink(
        `  https://studio.decocms.com/site-editor#endpoint=${endpoint}  `,
      ),
    ).toEqual({ endpoint: "http://127.0.0.1:4545/rpc" });
    expect(
      parseConnectLink(
        `https://studio.decocms.com/site-editor#endpoint=${endpoint}&token=t1`,
      ),
    ).toEqual({ endpoint: "http://127.0.0.1:4545/rpc" });
  });

  test("anything else is not a connect link", () => {
    expect(parseConnectLink("https://my-tunnel.example.com")).toBeNull();
    expect(parseConnectLink("http://localhost:8000")).toBeNull();
    expect(parseConnectLink("localhost:8000")).toBeNull();
    expect(parseConnectLink("")).toBeNull();
  });
});

describe("last connection", () => {
  const original = globalThis.localStorage;
  const fakeStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    } as unknown as Storage;
  };
  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: original,
      configurable: true,
    });
  });

  test("remembers the last endpoint per browser", () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeStorage(),
      configurable: true,
    });
    expect(readLastConnection()).toBeNull();
    saveLastConnection({ endpoint: "http://127.0.0.1:4545/rpc" });
    expect(readLastConnection()).toEqual({
      endpoint: "http://127.0.0.1:4545/rpc",
    });
    clearLastConnection();
    expect(readLastConnection()).toBeNull();
  });

  test("blocked storage reads as nothing remembered", () => {
    Object.defineProperty(globalThis, "localStorage", {
      get() {
        throw new Error("blocked");
      },
      configurable: true,
    });
    expect(() =>
      saveLastConnection({ endpoint: "http://127.0.0.1:4545/rpc" }),
    ).not.toThrow();
    expect(readLastConnection()).toBeNull();
    expect(() => clearLastConnection()).not.toThrow();
  });
});

describe("endpointHost", () => {
  test("names where the server listens", () => {
    expect(endpointHost("http://127.0.0.1:4545/rpc")).toBe("127.0.0.1:4545");
  });
});

describe("probeRetryDelay", () => {
  test("backs off from 1s to at most 10s", () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => probeRetryDelay(n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ]);
  });

  test("takes another cap", () => {
    expect([4, 5, 9].map((n) => probeRetryDelay(n, 15_000))).toEqual([
      8_000, 15_000, 15_000,
    ]);
  });
});

describe("parseServeAddress", () => {
  const ok = (endpoint: string) => ({
    ok: true as const,
    connection: { endpoint },
  });

  test("accepts the full Site editor link deco serve prints", () => {
    expect(
      parseServeAddress(
        `http://localhost:4000/site-editor#endpoint=${encodeURIComponent("http://127.0.0.1:4547/rpc")}`,
      ),
    ).toEqual(ok("http://127.0.0.1:4547/rpc"));
  });

  test("accepts just a port", () => {
    expect(parseServeAddress(" 4547 ")).toEqual(
      ok("http://127.0.0.1:4547/rpc"),
    );
  });

  test("accepts an address, with or without the scheme and /rpc", () => {
    expect(parseServeAddress("127.0.0.1:4547")).toEqual(
      ok("http://127.0.0.1:4547/rpc"),
    );
    expect(parseServeAddress("localhost:4548")).toEqual(
      ok("http://localhost:4548/rpc"),
    );
    expect(parseServeAddress("http://127.0.0.1:4550/rpc")).toEqual(
      ok("http://127.0.0.1:4550/rpc"),
    );
    expect(parseServeAddress("http://127.0.0.1:4550/")).toEqual(
      ok("http://127.0.0.1:4550/rpc"),
    );
  });

  test("rejects addresses off this machine as not local", () => {
    expect(parseServeAddress("example.com:4545")).toEqual({
      ok: false,
      reason: "not-local",
    });
    expect(parseServeAddress("https://evil.example/rpc")).toEqual({
      ok: false,
      reason: "not-local",
    });
    expect(
      parseServeAddress(
        `https://studio.decocms.com/site-editor#endpoint=${encodeURIComponent("https://evil.example/rpc")}`,
      ),
    ).toEqual({ ok: false, reason: "not-local" });
  });

  test("rejects junk as unrecognized", () => {
    for (const junk of [
      "",
      "   ",
      "hello world",
      "deco serve",
      "99999",
      "0",
      "localhost",
      "127.0.0.1:4545/some/page",
      "javascript:alert(1)",
    ]) {
      expect(parseServeAddress(junk)).toEqual({
        ok: false,
        reason: "unrecognized",
      });
    }
  });
});

describe("classifyServeProbeError", () => {
  test("no answer: a network error, an abort or a timeout", () => {
    expect(classifyServeProbeError(new TypeError("Failed to fetch"))).toEqual({
      reason: "not-answering",
    });
    expect(
      classifyServeProbeError(new DOMException("aborted", "AbortError")),
    ).toEqual({ reason: "not-answering" });
  });

  test("an older deco serve asks for a token", () => {
    expect(
      classifyServeProbeError(
        new ContentProtocolError(
          ErrorCode.Unauthorized,
          "missing or invalid bearer token",
        ),
      ),
    ).toEqual({ reason: "outdated" });
  });

  test("another major version", () => {
    expect(
      classifyServeProbeError(
        new ContentProtocolError(ErrorCode.Unsupported, "speaks 2.x"),
      ),
    ).toEqual({ reason: "version-mismatch" });
  });

  test("another program on the port", () => {
    expect(classifyServeProbeError(new NotDecoServeError())).toEqual({
      reason: "not-deco-serve",
    });
    expect(
      classifyServeProbeError(
        new ContentProtocolError(
          ErrorCode.Unavailable,
          "the endpoint answered HTTP 404 without a JSON-RPC body",
        ),
      ),
    ).toEqual({ reason: "not-deco-serve" });
  });

  test("any other error keeps the server's message", () => {
    expect(
      classifyServeProbeError(
        new ContentProtocolError(ErrorCode.InternalError, "disk full"),
      ),
    ).toEqual({ reason: "error", detail: "disk full" });
  });
});

describe("serveCommand", () => {
  test("adds --allow-origin only off the official Studio origins", () => {
    expect(serveCommand("https://studio.decocms.com")).toBe(
      "npx @decocms/blocks serve",
    );
    expect(serveCommand("http://localhost:4000")).toBe(
      "npx @decocms/blocks serve --allow-origin http://localhost:4000",
    );
  });
});

describe("discovery candidates", () => {
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  beforeEach(() => {
    const map = new Map<string, string>();
    Object.defineProperty(globalThis, "sessionStorage", {
      value: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
      } as unknown as Storage,
      configurable: true,
    });
  });
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  });

  test("the remembered server, then the default port, without repeats", () => {
    expect(discoveryCandidates(null, [])).toEqual([DEFAULT_SERVE_ENDPOINT]);
    expect(
      discoveryCandidates({ endpoint: "http://127.0.0.1:4547/rpc" }, []),
    ).toEqual(["http://127.0.0.1:4547/rpc", DEFAULT_SERVE_ENDPOINT]);
    expect(
      discoveryCandidates({ endpoint: DEFAULT_SERVE_ENDPOINT }, []),
    ).toEqual([DEFAULT_SERVE_ENDPOINT]);
  });

  test("skips a server disconnected in this session", () => {
    markDisconnected(DEFAULT_SERVE_ENDPOINT);
    expect(readDisconnected()).toEqual([DEFAULT_SERVE_ENDPOINT]);
    expect(discoveryCandidates(null, readDisconnected())).toEqual([]);
    unmarkDisconnected(DEFAULT_SERVE_ENDPOINT);
    expect(discoveryCandidates(null, readDisconnected())).toEqual([
      DEFAULT_SERVE_ENDPOINT,
    ]);
  });
});

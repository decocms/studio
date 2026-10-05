import { afterEach, describe, expect, test } from "bun:test";
import {
  clearLastConnection,
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
      parseConnectFragment(
        `#endpoint=http://127.0.0.1/${"x".repeat(2100)}`,
      ),
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
    expect(
      parseConnectFragment("#endpoint=http://127.0.0.1:4545/rpc"),
    ).toEqual({ endpoint: "http://127.0.0.1:4545/rpc" });
  });

  test("a connect link to another host is refused", () => {
    expect(
      parseConnectFragment("#endpoint=https://evil.example/rpc"),
    ).toBeNull();
  });
});

describe("parseStoredConnection", () => {
  test("accepts only a well-formed connection", () => {
    expect(parseStoredConnection({ endpoint: "http://127.0.0.1:1/rpc" })).toEqual(
      { endpoint: "http://127.0.0.1:1/rpc" },
    );
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
    expect([1, 2, 3, 4, 5, 9].map(probeRetryDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ]);
  });
});

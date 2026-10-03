import { describe, expect, test } from "bun:test";
import {
  isLoopbackEndpoint,
  parseConnectFragment,
  parseConnectLink,
  parseStoredConnection,
} from "./deco-serve-connection";

describe("parseConnectFragment", () => {
  test("reads the endpoint and token deco serve prints", () => {
    expect(
      parseConnectFragment(
        `#endpoint=${encodeURIComponent("http://127.0.0.1:4545/rpc")}&token=abc123`,
      ),
    ).toEqual({ endpoint: "http://127.0.0.1:4545/rpc", token: "abc123" });
  });

  test("refuses incomplete or unsafe links", () => {
    expect(parseConnectFragment("")).toBeNull();
    expect(parseConnectFragment("#token=abc")).toBeNull();
    expect(
      parseConnectFragment("#endpoint=http://127.0.0.1:4545/rpc"),
    ).toBeNull();
    expect(
      parseConnectFragment("#endpoint=javascript:alert(1)&token=abc"),
    ).toBeNull();
    expect(parseConnectFragment("#endpoint=not a url&token=abc")).toBeNull();
    expect(
      parseConnectFragment(
        `#endpoint=http://127.0.0.1/rpc&token=${"x".repeat(2000)}`,
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
      "https://site.localhost/rpc",
    ]) {
      expect(isLoopbackEndpoint(endpoint)).toBe(true);
    }
    for (const endpoint of [
      "https://evil.example/rpc",
      "http://127.0.0.1.evil.example/rpc",
      "http://localhost.evil.example/rpc",
      "http://10.0.0.2:4545/rpc",
      "ftp://127.0.0.1/rpc",
      "not a url",
    ]) {
      expect(isLoopbackEndpoint(endpoint)).toBe(false);
    }
  });

  test("a connect link to another host is refused", () => {
    expect(
      parseConnectFragment("#endpoint=https://evil.example/rpc&token=x"),
    ).toBeNull();
  });
});

describe("parseStoredConnection", () => {
  test("accepts only a well-formed connection", () => {
    expect(
      parseStoredConnection({ endpoint: "http://127.0.0.1:1/rpc", token: "t" }),
    ).toEqual({ endpoint: "http://127.0.0.1:1/rpc", token: "t" });
    expect(parseStoredConnection(null)).toBeNull();
    expect(parseStoredConnection("http://127.0.0.1:1/rpc")).toBeNull();
    expect(parseStoredConnection({ endpoint: "x", token: "" })).toBeNull();
  });
});

describe("parseConnectLink", () => {
  const endpoint = encodeURIComponent("http://127.0.0.1:4545/rpc");

  test("reads a pasted site editor or connect link", () => {
    for (const path of ["/site-editor", "/connect"]) {
      expect(
        parseConnectLink(
          `  https://studio.decocms.com${path}#endpoint=${endpoint}&token=t1  `,
        ),
      ).toEqual({ endpoint: "http://127.0.0.1:4545/rpc", token: "t1" });
    }
  });

  test("anything else is not a connect link", () => {
    expect(parseConnectLink("https://my-tunnel.example.com")).toBeNull();
    expect(parseConnectLink("http://localhost:8000")).toBeNull();
    expect(parseConnectLink("localhost:8000")).toBeNull();
    expect(parseConnectLink("")).toBeNull();
  });
});

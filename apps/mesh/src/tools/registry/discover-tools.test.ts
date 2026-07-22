import { describe, expect, it } from "bun:test";
import {
  fetchWithoutRedirects,
  isPrivateUrl,
  parseToolsListResponse,
} from "./discover-tools";

describe("isPrivateUrl", () => {
  it("blocks plain private/loopback/link-local IPv4", () => {
    expect(isPrivateUrl("http://127.0.0.1/")).toBe(true);
    expect(isPrivateUrl("http://10.0.0.5/")).toBe(true);
    expect(isPrivateUrl("http://169.254.169.254/")).toBe(true);
  });

  it("blocks RFC 6598 CGNAT shared address space (100.64.0.0/10)", () => {
    // Alibaba Cloud's internal metadata endpoint lives in this range.
    expect(isPrivateUrl("http://100.100.100.200/")).toBe(true);
    expect(isPrivateUrl("http://100.64.0.1/")).toBe(true);
    expect(isPrivateUrl("http://100.127.255.255/")).toBe(true);
    // Outside the /10: 100.63.x.x and 100.128.x.x are ordinary public space.
    expect(isPrivateUrl("http://100.63.255.255/")).toBe(false);
    expect(isPrivateUrl("http://100.128.0.0/")).toBe(false);
  });

  it("blocks a 6to4-embedded CGNAT IPv4 address", () => {
    // 2002:6464:6464:: embeds 100.100.100.100 (within 100.64.0.0/10)
    expect(isPrivateUrl("http://[2002:6464:6464::]/")).toBe(true);
  });

  it("blocks a 6to4-embedded private IPv4 address", () => {
    // 2002:7f00:1:: embeds 127.0.0.1 (6to4: 2002:WWXX:YYZZ::)
    expect(isPrivateUrl("http://[2002:7f00:1::]/")).toBe(true);
    // 2002:a9fe:a9fe:: embeds 169.254.169.254 (cloud metadata endpoint)
    expect(isPrivateUrl("http://[2002:a9fe:a9fe::]/")).toBe(true);
  });

  it("blocks a NAT64-embedded private IPv4 address", () => {
    // 64:ff9b::/96 well-known prefix + embedded IPv4 in the last 32 bits
    expect(isPrivateUrl("http://[64:ff9b::127.0.0.1]/")).toBe(true);
    expect(isPrivateUrl("http://[64:ff9b::169.254.169.254]/")).toBe(true);
  });

  it("blocks a private IPv4 embedded via deprecated IPv4-compatible IPv6 (::a.b.c.d)", () => {
    // `new URL()` normalizes ::127.0.0.1 to ::7f00:1 before isPrivateUrl sees
    // it — the old dotted-quad regex never matched, silently letting these
    // through despite looking like an active guard.
    expect(isPrivateUrl("http://[::127.0.0.1]/")).toBe(true);
    expect(isPrivateUrl("http://[::10.0.0.5]/")).toBe(true);
    expect(isPrivateUrl("http://[::192.168.1.1]/")).toBe(true);
    expect(isPrivateUrl("http://[::100.100.100.200]/")).toBe(true);
  });

  it("does not block a public IPv4 embedded via 6to4/NAT64", () => {
    // 2002:0808:0808:: embeds 8.8.8.8
    expect(isPrivateUrl("http://[2002:808:808::]/")).toBe(false);
    expect(isPrivateUrl("http://[64:ff9b::8.8.8.8]/")).toBe(false);
  });

  it("does not block ordinary public URLs", () => {
    expect(isPrivateUrl("https://example.com/mcp")).toBe(false);
    expect(isPrivateUrl("http://8.8.8.8/")).toBe(false);
    expect(isPrivateUrl("http://[::8.8.8.8]/")).toBe(false);
  });
});

describe("fetchWithoutRedirects", () => {
  it("forces redirect: manual so a remote server can't 3xx to a private address, even if called with redirect: follow", async () => {
    const calls: RequestInit[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response("ok");
    }) as typeof fetch;

    try {
      await fetchWithoutRedirects("http://example.com", {
        redirect: "follow",
        headers: { "x-test": "1" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls[0]?.redirect).toBe("manual");
    expect(calls[0]?.headers).toEqual({ "x-test": "1" });
  });
});

describe("parseToolsListResponse", () => {
  it("parses a plain JSON-RPC tools/list response", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "search", description: "Search the web" }] },
    });
    expect(parseToolsListResponse(body)).toEqual([
      { name: "search", description: "Search the web" },
    ]);
  });

  it("parses an SSE-framed tools/list response", () => {
    const body = `event: message\ndata: ${JSON.stringify({
      result: { tools: [{ name: "search" }] },
    })}\n\n`;
    expect(parseToolsListResponse(body)).toEqual([
      { name: "search", description: null },
    ]);
  });

  it("rejects a malformed tool shape instead of passing it through", () => {
    // A remote MCP server isn't a trusted source — unlike the SDK client
    // path (which validates via zod), this raw fallback path is the only
    // thing standing between a malformed response and the UI, which renders
    // `tool.name` as a React child and uses it as a list key.
    const body = JSON.stringify({
      result: { tools: [{ name: { evil: true } }] },
    });
    expect(parseToolsListResponse(body)).toBeNull();
  });

  it("returns null for non-array tools or unparsable JSON", () => {
    expect(parseToolsListResponse(JSON.stringify({ result: {} }))).toBeNull();
    expect(parseToolsListResponse("not json")).toBeNull();
  });
});

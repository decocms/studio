import { describe, expect, it } from "bun:test";
import {
  isPrivateUrl,
  parseToolsListResponse,
  resolvesToPrivateAddress,
  withTimeout,
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

describe("resolvesToPrivateAddress", () => {
  it("blocks a domain whose DNS record points at a private/metadata address", async () => {
    // e.g. an attacker-controlled domain with an A record for the cloud
    // metadata endpoint — isPrivateUrl never sees a literal IP to catch this.
    const resolveHost = async () => ["169.254.169.254"];
    expect(await resolvesToPrivateAddress("evil.com", resolveHost)).toBe(true);
  });

  it("allows a domain that resolves only to public addresses", async () => {
    const resolveHost = async () => ["93.184.216.34"];
    expect(await resolvesToPrivateAddress("example.com", resolveHost)).toBe(
      false,
    );
  });

  it("blocks if any resolved address (v4 or v6) is private, even alongside public ones", async () => {
    const resolveHost = async () => ["8.8.8.8", "10.0.0.5"];
    expect(await resolvesToPrivateAddress("mixed.example", resolveHost)).toBe(
      true,
    );
    const resolveHostV6 = async () => ["2001:db8::1", "::1"];
    expect(
      await resolvesToPrivateAddress("mixed-v6.example", resolveHostV6),
    ).toBe(true);
  });

  it("fails closed when resolution throws or returns nothing", async () => {
    const throwing = async () => {
      throw new Error("NXDOMAIN");
    };
    expect(await resolvesToPrivateAddress("nowhere.example", throwing)).toBe(
      true,
    );

    const empty = async () => [];
    expect(await resolvesToPrivateAddress("empty.example", empty)).toBe(true);
  });
});

describe("withTimeout", () => {
  it("clears its timer once the wrapped promise wins, instead of firing an unhandled rejection later", async () => {
    let rejection: unknown;
    const onUnhandledRejection = (reason: unknown) => {
      rejection = reason;
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await withTimeout(Promise.resolve("fast"), 10, "should not fire");
      // Give the (leaked, if the bug regresses) timer a chance to fire.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejection).toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("still rejects with the timeout message when the wrapped promise is too slow", async () => {
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 10, "too slow")).rejects.toThrow(
      "too slow",
    );
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

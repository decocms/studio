import { describe, expect, it } from "bun:test";
import { isPrivateUrl } from "./discover-tools";

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

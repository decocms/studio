/**
 * SSRF Validator Tests
 *
 * Tests for normalizeUrl, validateUrl, and isPrivateIp.
 * Uses Bun's built-in test runner.
 */

import { describe, expect, test } from "bun:test";
import { isPrivateIp, normalizeUrl, validateUrl } from "./ssrf-validator";

// ============================================================================
// isPrivateIp tests
// ============================================================================

describe("isPrivateIp", () => {
  // IPv4 loopback
  test("127.0.0.1 is private (loopback)", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
  });

  test("127.255.255.255 is private (loopback range)", () => {
    expect(isPrivateIp("127.255.255.255")).toBe(true);
  });

  // Private class A
  test("10.255.255.255 is private (class A)", () => {
    expect(isPrivateIp("10.255.255.255")).toBe(true);
  });

  test("10.0.0.1 is private (class A)", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
  });

  // Private class B
  test("172.16.0.0 is private (class B start)", () => {
    expect(isPrivateIp("172.16.0.0")).toBe(true);
  });

  test("172.31.255.255 is private (class B end)", () => {
    expect(isPrivateIp("172.31.255.255")).toBe(true);
  });

  test("172.32.0.0 is NOT private (outside /12 range)", () => {
    expect(isPrivateIp("172.32.0.0")).toBe(false);
  });

  test("172.15.255.255 is NOT private (below /12 range)", () => {
    expect(isPrivateIp("172.15.255.255")).toBe(false);
  });

  // Private class C
  test("192.168.0.1 is private (class C)", () => {
    expect(isPrivateIp("192.168.0.1")).toBe(true);
  });

  test("192.168.255.255 is private (class C)", () => {
    expect(isPrivateIp("192.168.255.255")).toBe(true);
  });

  // Link-local
  test("169.254.0.1 is private (link-local)", () => {
    expect(isPrivateIp("169.254.0.1")).toBe(true);
  });

  // Unspecified
  test("0.0.0.0 is private (unspecified)", () => {
    expect(isPrivateIp("0.0.0.0")).toBe(true);
  });

  // Public
  test("8.8.8.8 is NOT private (Google DNS)", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  test("1.1.1.1 is NOT private (Cloudflare DNS)", () => {
    expect(isPrivateIp("1.1.1.1")).toBe(false);
  });

  test("93.184.216.34 is NOT private (example.com)", () => {
    expect(isPrivateIp("93.184.216.34")).toBe(false);
  });

  // IPv6 loopback
  test("::1 is private (IPv6 loopback)", () => {
    expect(isPrivateIp("::1")).toBe(true);
  });

  // IPv4-mapped IPv6
  test("::ffff:127.0.0.1 is private (IPv4-mapped loopback)", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
  });

  test("::ffff:192.168.1.1 is private (IPv4-mapped private)", () => {
    expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true);
  });

  test("::ffff:8.8.8.8 is NOT private (IPv4-mapped public)", () => {
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
  });
});

// ============================================================================
// normalizeUrl tests
// ============================================================================

describe("normalizeUrl", () => {
  test("valid https URL passes through", () => {
    const result = normalizeUrl("https://example.com");
    expect(result.normalized).toBe("https://example.com");
  });

  test("prepends https:// when no protocol provided", () => {
    const result = normalizeUrl("example.com");
    expect(result.normalized).toBe("https://example.com");
  });

  test("prepends https:// to URL with path and no protocol", () => {
    const result = normalizeUrl("example.com/shop");
    expect(result.normalized).toBe("https://example.com/shop");
  });

  test("preserves explicit http protocol", () => {
    const result = normalizeUrl("http://example.com");
    expect(result.normalized).toBe("http://example.com");
  });

  test("rejects ftp:// protocol", () => {
    expect(() => normalizeUrl("ftp://example.com")).toThrow(
      /unsupported protocol/i,
    );
  });

  test("rejects file:// protocol", () => {
    expect(() => normalizeUrl("file:///etc/passwd")).toThrow(
      /unsupported protocol/i,
    );
  });

  test("rejects data: URI", () => {
    expect(() =>
      normalizeUrl("data:text/html,<script>alert(1)</script>"),
    ).toThrow(/unsupported protocol/i);
  });

  test("strips trailing slash from root path", () => {
    const result = normalizeUrl("https://example.com/");
    expect(result.normalized).toBe("https://example.com");
  });

  test("lowercases hostname", () => {
    const result = normalizeUrl("https://EXAMPLE.COM");
    expect(result.normalized).toBe("https://example.com");
  });

  test("lowercases mixed-case hostname", () => {
    const result = normalizeUrl("https://Example.Com/Shop");
    expect(result.normalized).toBe("https://example.com/Shop");
  });

  test("preserves non-root path", () => {
    const result = normalizeUrl("https://example.com/shop");
    expect(result.normalized).toBe("https://example.com/shop");
  });

  test("preserves query string", () => {
    const result = normalizeUrl("https://example.com/search?q=test");
    expect(result.normalized).toBe("https://example.com/search?q=test");
  });

  test("strips hash fragment", () => {
    const result = normalizeUrl("https://example.com/page#section");
    expect(result.normalized).toBe("https://example.com/page");
  });

  test("removes default http port :80", () => {
    const result = normalizeUrl("http://example.com:80/page");
    expect(result.normalized).toBe("http://example.com/page");
  });

  test("removes default https port :443", () => {
    const result = normalizeUrl("https://example.com:443/page");
    expect(result.normalized).toBe("https://example.com/page");
  });

  test("preserves non-default port", () => {
    const result = normalizeUrl("https://example.com:8080/api");
    expect(result.normalized).toBe("https://example.com:8080/api");
  });

  test("rejects empty string", () => {
    expect(() => normalizeUrl("")).toThrow(/empty/i);
  });

  test("rejects whitespace-only string", () => {
    expect(() => normalizeUrl("   ")).toThrow(/empty/i);
  });

  test("returns parsed URL object", () => {
    const result = normalizeUrl("https://example.com/shop");
    expect(result.url).toBeInstanceOf(URL);
    expect(result.url.hostname).toBe("example.com");
  });
});

// ============================================================================
// validateUrl tests
// ============================================================================

describe("validateUrl", () => {
  test("rejects localhost immediately (no DNS lookup)", async () => {
    await expect(validateUrl("localhost")).rejects.toThrow(
      /private\/internal/i,
    );
  });

  test("rejects http://localhost", async () => {
    await expect(validateUrl("http://localhost")).rejects.toThrow(
      /private\/internal/i,
    );
  });

  test("rejects 127.0.0.1 (loopback IP)", async () => {
    await expect(validateUrl("http://127.0.0.1")).rejects.toThrow(
      /private\/internal/i,
    );
  });

  test("rejects 10.0.0.1 (private range)", async () => {
    await expect(validateUrl("http://10.0.0.1")).rejects.toThrow(
      /private\/internal/i,
    );
  });

  test("rejects 192.168.1.1 (private range)", async () => {
    await expect(validateUrl("http://192.168.1.1")).rejects.toThrow(
      /private\/internal/i,
    );
  });

  test("rejects 172.16.0.1 (private range)", async () => {
    await expect(validateUrl("http://172.16.0.1")).rejects.toThrow(
      /private\/internal/i,
    );
  });

  test("rejects 0.0.0.0 (unspecified)", async () => {
    await expect(validateUrl("http://0.0.0.0")).rejects.toThrow(
      /private\/internal/i,
    );
  });

  test("rejects empty string", async () => {
    await expect(validateUrl("")).rejects.toThrow(/empty/i);
  });

  test("rejects string with only spaces", async () => {
    await expect(validateUrl("   ")).rejects.toThrow(/empty/i);
  });

  test("accepts a valid public hostname (example.com)", async () => {
    // example.com is a well-known IANA domain — always resolves to public IPs
    const result = await validateUrl("example.com");
    expect(result.url.hostname).toBe("example.com");
    expect(result.normalized).toBe("https://example.com");
  });
});

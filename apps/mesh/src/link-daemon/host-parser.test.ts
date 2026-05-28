import { describe, expect, test } from "bun:test";
import { parseHandleFromHost } from "./host-parser";

describe("parseHandleFromHost", () => {
  test("extracts handle with explicit port", () => {
    expect(parseHandleFromHost("abc123.localhost:5174")).toBe("abc123");
  });

  test("extracts handle with no port", () => {
    expect(parseHandleFromHost("abc123.localhost")).toBe("abc123");
  });

  test("lowercases the handle", () => {
    expect(parseHandleFromHost("ABC123.localhost:5174")).toBe("abc123");
  });

  test("trims trailing dot in host", () => {
    expect(parseHandleFromHost("abc.localhost.:5174")).toBe("abc");
  });

  test("rejects bare localhost (no handle)", () => {
    expect(parseHandleFromHost("localhost:5174")).toBeNull();
    expect(parseHandleFromHost("localhost")).toBeNull();
  });

  test("rejects non-localhost hosts", () => {
    expect(parseHandleFromHost("abc.example.com:5174")).toBeNull();
    expect(parseHandleFromHost("evil.com")).toBeNull();
  });

  test("rejects empty and undefined input", () => {
    expect(parseHandleFromHost("")).toBeNull();
    expect(parseHandleFromHost(null)).toBeNull();
    expect(parseHandleFromHost(undefined)).toBeNull();
  });

  test("rejects IPv6 hosts", () => {
    expect(parseHandleFromHost("[::1]:5174")).toBeNull();
  });

  test("rejects handles with dots inside", () => {
    // Multi-level subdomains aren't supported — handle must be a single
    // label directly under .localhost.
    expect(parseHandleFromHost("a.b.localhost:5174")).toBeNull();
  });
});

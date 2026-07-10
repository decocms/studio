import { describe, expect, test } from "bun:test";
import {
  isHttpTokenEndpoint,
  nonEmptyString,
  normalizeRepositoryId,
} from "./provision-repo-scoped-github-connection.ts";

describe("nonEmptyString", () => {
  test("trims and accepts a non-empty string", () => {
    expect(nonEmptyString("  hello  ")).toBe("hello");
  });

  test("rejects whitespace-only strings", () => {
    expect(nonEmptyString("   ")).toBeNull();
  });

  test("rejects non-string values", () => {
    expect(nonEmptyString(undefined)).toBeNull();
    expect(nonEmptyString(123)).toBeNull();
  });
});

describe("isHttpTokenEndpoint", () => {
  test("accepts plain https/http URLs", () => {
    expect(isHttpTokenEndpoint("https://github.com/token")).toBe(true);
    expect(isHttpTokenEndpoint("http://github.com/token")).toBe(true);
  });

  test("rejects non-http(s) protocols", () => {
    expect(isHttpTokenEndpoint("javascript:alert(1)")).toBe(false);
    expect(isHttpTokenEndpoint("ftp://github.com/token")).toBe(false);
  });

  test("rejects URLs carrying embedded credentials", () => {
    expect(isHttpTokenEndpoint("https://user:pass@github.com/token")).toBe(
      false,
    );
  });

  test("rejects malformed URLs", () => {
    expect(isHttpTokenEndpoint("not a url")).toBe(false);
  });
});

describe("normalizeRepositoryId", () => {
  test("accepts positive integers", () => {
    expect(normalizeRepositoryId(42)).toBe(42);
  });

  test("rejects non-integers, non-positive numbers, and non-numbers", () => {
    expect(normalizeRepositoryId(1.5)).toBeUndefined();
    expect(normalizeRepositoryId(0)).toBeUndefined();
    expect(normalizeRepositoryId(-1)).toBeUndefined();
    expect(normalizeRepositoryId(Number.NaN)).toBeUndefined();
    expect(normalizeRepositoryId("42")).toBeUndefined();
  });
});

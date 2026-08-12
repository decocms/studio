import { describe, expect, test } from "bun:test";
import { parsePositiveIntFlag } from "./parse-positive-int-flag";

describe("parsePositiveIntFlag", () => {
  test("undefined when the flag wasn't passed", () => {
    expect(parsePositiveIntFlag("batch", undefined)).toBeUndefined();
  });

  test("parses a positive integer", () => {
    expect(parsePositiveIntFlag("batch", "500")).toBe(500);
  });

  test("rejects a non-numeric value", () => {
    expect(() => parsePositiveIntFlag("batch", "abc")).toThrow(
      'Invalid --batch "abc" — must be a positive integer.',
    );
  });

  test("rejects zero and negative values", () => {
    expect(() => parsePositiveIntFlag("limit", "0")).toThrow();
    expect(() => parsePositiveIntFlag("limit", "-5")).toThrow();
  });

  test("rejects a non-integer value", () => {
    expect(() => parsePositiveIntFlag("batch", "1.5")).toThrow();
  });

  test("accepts a value within an optional max", () => {
    expect(parsePositiveIntFlag("port", "3000", 65535)).toBe(3000);
  });

  test("rejects a value above an optional max", () => {
    expect(() => parsePositiveIntFlag("port", "70000", 65535)).toThrow(
      'Invalid --port "70000" — must be a positive integer up to 65535.',
    );
  });
});

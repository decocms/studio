import { describe, expect, test } from "bun:test";
import { normalizeOptions } from "./dynamic-options-field";

describe("normalizeOptions", () => {
  test("returns empty array for non-array input", () => {
    expect(normalizeOptions(null)).toEqual([]);
    expect(normalizeOptions(undefined)).toEqual([]);
    expect(normalizeOptions("hello")).toEqual([]);
    expect(normalizeOptions(42)).toEqual([]);
    expect(normalizeOptions({})).toEqual([]);
  });

  test("returns empty array for empty array", () => {
    expect(normalizeOptions([])).toEqual([]);
  });

  test("converts string items to {value, label}", () => {
    expect(normalizeOptions(["a", "b"])).toEqual([
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ]);
  });

  test("passes through object items with value field", () => {
    const input = [
      { value: "x", label: "Option X" },
      { value: "y", label: "Option Y", image: "https://img.test/y.png" },
    ];
    expect(normalizeOptions(input)).toEqual([
      { value: "x", label: "Option X", image: undefined },
      { value: "y", label: "Option Y", image: "https://img.test/y.png" },
    ]);
  });

  test("uses String(value) as label when label is missing", () => {
    expect(normalizeOptions([{ value: 123 }])).toEqual([
      { value: "123", label: "123", image: undefined },
    ]);
  });

  test("ignores items without value field", () => {
    expect(normalizeOptions([{ label: "no value" }, null, 42])).toEqual([]);
  });

  test("handles mixed string and object items", () => {
    const result = normalizeOptions([
      "plain",
      { value: "obj", label: "Object" },
    ]);
    expect(result).toEqual([
      { value: "plain", label: "plain" },
      { value: "obj", label: "Object", image: undefined },
    ]);
  });

  test("ignores non-string image values", () => {
    expect(normalizeOptions([{ value: "v", image: 123 }])).toEqual([
      { value: "v", label: "v", image: undefined },
    ]);
  });
});

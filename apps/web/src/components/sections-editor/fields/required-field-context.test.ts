import { describe, expect, test } from "bun:test";
import { isEmptyFieldValue } from "./required-field-context";

describe("isEmptyFieldValue", () => {
  test("null and undefined are empty", () => {
    expect(isEmptyFieldValue(null)).toBe(true);
    expect(isEmptyFieldValue(undefined)).toBe(true);
  });

  test("empty and whitespace-only strings are empty", () => {
    expect(isEmptyFieldValue("")).toBe(true);
    expect(isEmptyFieldValue("   ")).toBe(true);
    expect(isEmptyFieldValue("\n\t")).toBe(true);
  });

  test("non-blank strings are not empty", () => {
    expect(isEmptyFieldValue("hi")).toBe(false);
    expect(isEmptyFieldValue(" a ")).toBe(false);
  });

  test("empty array is empty, populated array is not", () => {
    expect(isEmptyFieldValue([])).toBe(true);
    expect(isEmptyFieldValue([0])).toBe(false);
  });

  test("object with no own keys is empty, with keys is not", () => {
    expect(isEmptyFieldValue({})).toBe(true);
    expect(isEmptyFieldValue({ a: 1 })).toBe(false);
  });

  test("falsy-but-valid primitives are not empty", () => {
    expect(isEmptyFieldValue(0)).toBe(false);
    expect(isEmptyFieldValue(false)).toBe(false);
  });
});

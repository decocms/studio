import { describe, expect, test } from "bun:test";
import { jsonField, parseJsonArray } from "./primitives";

describe("jsonField", () => {
  test("passes an already-encoded string through unchanged", () => {
    expect(jsonField('[{"title":"a"}]')).toBe('[{"title":"a"}]');
  });

  test("re-encodes a stored array instead of coercing it to an empty string", () => {
    const stored = [{ title: "a" }, { title: "b" }];
    const field = jsonField(stored);
    expect(parseJsonArray(field)).toEqual(stored);
  });

  test("falls back to the given default for null/undefined", () => {
    expect(jsonField(undefined)).toBe("[]");
    expect(jsonField(null, {})).toBe("{}");
  });
});

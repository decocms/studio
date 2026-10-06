import { describe, expect, test } from "bun:test";
import { jsonField, normalizeAnchorId, parseJsonArray } from "./primitives";

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

describe("normalizeAnchorId", () => {
  test("strips whitespace at the ends and between characters alike", () => {
    expect(normalizeAnchorId("  minha faq 1 ")).toBe("minhafaq1");
  });

  test("strips tabs and newlines, not just spaces", () => {
    expect(normalizeAnchorId("a\tb\nc")).toBe("abc");
  });

  test("leaves an already-clean id alone", () => {
    expect(normalizeAnchorId("perguntas-frequentes")).toBe(
      "perguntas-frequentes",
    );
  });

  test("collapses a whitespace-only value to empty", () => {
    expect(normalizeAnchorId("   ")).toBe("");
    expect(normalizeAnchorId("")).toBe("");
  });
});

import { describe, expect, test } from "bun:test";
import {
  coerceFormValues,
  seedFormValues,
  toolInputSummary,
} from "./tile-form-values";

describe("coerceFormValues", () => {
  test("parses object/array JSON strings", () => {
    expect(
      coerceFormValues({ foo: '{"a":1}' }, { foo: { type: "object" } }),
    ).toEqual({ foo: { a: 1 } });
  });

  test("returns null on invalid JSON", () => {
    expect(
      coerceFormValues({ foo: "{not json" }, { foo: { type: "object" } }),
    ).toBeNull();
  });

  test("converts number/integer strings", () => {
    expect(coerceFormValues({ n: "42" }, { n: { type: "integer" } })).toEqual({
      n: 42,
    });
  });

  test("returns null on non-numeric string for number/integer field", () => {
    expect(
      coerceFormValues({ n: "abc" }, { n: { type: "integer" } }),
    ).toBeNull();
  });

  test("returns null on fractional string for integer field", () => {
    expect(
      coerceFormValues({ n: "3.5" }, { n: { type: "integer" } }),
    ).toBeNull();
  });

  test("accepts fractional string for number field", () => {
    expect(coerceFormValues({ n: "3.5" }, { n: { type: "number" } })).toEqual({
      n: 3.5,
    });
  });

  test("returns null on Infinity string for number field", () => {
    expect(
      coerceFormValues({ n: "Infinity" }, { n: { type: "number" } }),
    ).toBeNull();
    expect(
      coerceFormValues({ n: "-Infinity" }, { n: { type: "number" } }),
    ).toBeNull();
  });

  test("returns null on a raw (non-string) Infinity/NaN for number field", () => {
    // seedFormValues passes numeric toolInput values through unstringified,
    // so an untouched field can reach coerceFormValues as a real number.
    expect(
      coerceFormValues({ n: Infinity }, { n: { type: "number" } }),
    ).toBeNull();
    expect(coerceFormValues({ n: NaN }, { n: { type: "number" } })).toBeNull();
  });

  test("drops empty values", () => {
    expect(coerceFormValues({ s: "" }, { s: { type: "string" } })).toEqual({});
  });

  test("returns null when a required field is left blank", () => {
    expect(
      coerceFormValues({ s: "" }, { s: { type: "string" } }, ["s"]),
    ).toBeNull();
  });

  test("accepts a filled required field", () => {
    expect(
      coerceFormValues({ s: "hi" }, { s: { type: "string" } }, ["s"]),
    ).toEqual({ s: "hi" });
  });

  test("drops whitespace-only string values", () => {
    expect(coerceFormValues({ s: "   " }, { s: { type: "string" } })).toEqual(
      {},
    );
  });

  test("returns null when a required field is only whitespace", () => {
    expect(
      coerceFormValues({ s: "   " }, { s: { type: "string" } }, ["s"]),
    ).toBeNull();
  });
});

describe("seedFormValues", () => {
  test("stringifies object/array values for display", () => {
    expect(
      seedFormValues({ foo: { a: 1 } }, { foo: { type: "object" } }),
    ).toEqual({ foo: JSON.stringify({ a: 1 }, null, 2) });
  });

  test("passes through non-object values", () => {
    expect(seedFormValues({ s: "hi" }, { s: { type: "string" } })).toEqual({
      s: "hi",
    });
  });

  test("returns empty object when toolInput or properties missing", () => {
    expect(seedFormValues(undefined, {})).toEqual({});
    expect(seedFormValues({ s: "hi" }, undefined)).toEqual({});
  });
});

describe("toolInputSummary", () => {
  test("returns empty string when no toolInput", () => {
    expect(toolInputSummary(undefined)).toBe("");
  });

  test("filters empty entries and truncates long values", () => {
    expect(
      toolInputSummary({
        a: "short",
        b: "",
        c: null,
        d: "a".repeat(30),
      }),
    ).toBe(`a=short, d=${"a".repeat(20)}…`);
  });

  test("caps at 3 entries", () => {
    expect(toolInputSummary({ a: 1, b: 2, c: 3, d: 4 })).toBe("a=1, b=2, c=3");
  });
});

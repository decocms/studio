import { describe, expect, test } from "bun:test";
import { checkCount } from "./categorias-variant.tsx";

describe("checkCount", () => {
  test("reads the count out of the engine's caption", () => {
    expect(checkCount("Crítico (16 verificações)")).toBe(16);
    expect(checkCount("Bom (26 verificações)")).toBe(26);
  });

  test("reads a count of one — the caller renders the singular noun", () => {
    // The engine writes "1 verificações"; the count is what we translate from.
    expect(checkCount("Crítico (1 verificações)")).toBe(1);
  });

  test("ignores digits outside the parenthesis", () => {
    expect(checkCount("Top 10 (5 verificações)")).toBe(5);
  });

  test("returns null when there's nothing to count", () => {
    expect(checkCount(undefined)).toBeNull();
    expect(checkCount("")).toBeNull();
    expect(checkCount("Crítico")).toBeNull();
    expect(checkCount("Crítico (sem dados)")).toBeNull();
  });
});

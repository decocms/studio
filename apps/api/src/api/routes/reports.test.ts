import { describe, expect, test } from "bun:test";
import { parseRunBody } from "./reports";

describe("parseRunBody", () => {
  test("a literal JSON null body doesn't crash — no domain, no distinctId", () => {
    expect(parseRunBody(null)).toEqual({ domain: "", distinctId: undefined });
  });

  test("a non-object JSON body (array/string/number) also degrades safely", () => {
    expect(parseRunBody([])).toEqual({ domain: "", distinctId: undefined });
    expect(parseRunBody("nike.com")).toEqual({
      domain: "",
      distinctId: undefined,
    });
    expect(parseRunBody(42)).toEqual({ domain: "", distinctId: undefined });
  });

  test("trims domain and accepts a well-formed distinctId", () => {
    expect(parseRunBody({ domain: " nike.com ", distinctId: " abc " })).toEqual(
      { domain: "nike.com", distinctId: "abc" },
    );
  });

  test("drops an oversized distinctId", () => {
    const { distinctId } = parseRunBody({
      domain: "nike.com",
      distinctId: "x".repeat(201),
    });
    expect(distinctId).toBeUndefined();
  });
});

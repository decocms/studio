import { describe, expect, it } from "bun:test";
import { likePatternToRegExp } from "../src/well-known/collections";

describe("likePatternToRegExp", () => {
  it("collapses % runs so adjacent .* cannot form (ReDoS guard)", () => {
    expect(likePatternToRegExp("%%%a%%%").source).toBe("^.*a.*$");
    expect(likePatternToRegExp("%".repeat(50)).source).toBe("^.*$");
  });

  it("still matches LIKE semantics", () => {
    expect(likePatternToRegExp("%x").test("abcx")).toBe(true);
    expect(likePatternToRegExp("a_c").test("abc")).toBe(true);
    expect(likePatternToRegExp("a_c").test("ac")).toBe(false);
    expect(likePatternToRegExp("%%%x%%%").test("aaxbb")).toBe(true);
  });

  it("does not hang on a pathological all-% pattern (collapsed)", () => {
    const start = Date.now();
    likePatternToRegExp("%".repeat(60) + "!").test("a".repeat(60));
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

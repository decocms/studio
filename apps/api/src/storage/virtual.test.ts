import { describe, expect, it } from "bun:test";
import { escapeLikePattern } from "./virtual";

/**
 * The cross-org search box interpolates a user-typed term into a LIKE pattern.
 * Every case here is a term someone can type into the sidebar.
 */
describe("escapeLikePattern", () => {
  it("leaves an ordinary term alone", () => {
    expect(escapeLikePattern("checkout")).toBe("checkout");
    expect(escapeLikePattern("Storefront BR")).toBe("Storefront BR");
  });

  it("escapes the wildcard that would match every project in every org", () => {
    expect(escapeLikePattern("%")).toBe("\\%");
    expect(escapeLikePattern("50% off")).toBe("50\\% off");
  });

  it("escapes the single-character wildcard", () => {
    expect(escapeLikePattern("_")).toBe("\\_");
    expect(escapeLikePattern("my_project")).toBe("my\\_project");
  });

  /** Unescaped, `\%` reaches Postgres as a backslash escaping OUR percent. */
  it("escapes a backslash, so it cannot escape our own escapes", () => {
    expect(escapeLikePattern("\\")).toBe("\\\\");
    expect(escapeLikePattern("\\%")).toBe("\\\\\\%");
  });

  /** `a\_b` → backslash doubled first, then the underscore escaped. */
  it("escapes the backslash first, so no escape is double-processed", () => {
    expect(escapeLikePattern("a\\_b")).toBe("a\\\\\\_b");
  });

  it("handles the empty term", () => {
    expect(escapeLikePattern("")).toBe("");
  });
});

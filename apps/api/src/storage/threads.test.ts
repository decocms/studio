import { describe, it, expect } from "bun:test";
import { escapeLikePattern } from "./threads";

describe("escapeLikePattern", () => {
  it("escapes % so it matches a literal percent sign", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
  });

  it("escapes _ so it matches a literal underscore", () => {
    expect(escapeLikePattern("foo_bar")).toBe("foo\\_bar");
  });

  it("escapes a literal backslash", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeLikePattern("hello world")).toBe("hello world");
  });
});

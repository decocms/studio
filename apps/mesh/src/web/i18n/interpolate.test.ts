import { describe, expect, it } from "bun:test";
import { interpolate } from "./interpolate.ts";

describe("interpolate", () => {
  it("returns the template unchanged when no vars are given", () => {
    expect(interpolate("Hello world")).toBe("Hello world");
    expect(interpolate("Hello {name}")).toBe("Hello {name}");
  });

  it("replaces placeholders with values", () => {
    expect(interpolate("Hello {name}", { name: "Ada" })).toBe("Hello Ada");
  });

  it("replaces repeated placeholders", () => {
    expect(interpolate("{n} of {n}", { n: 3 })).toBe("3 of 3");
  });

  it("stringifies numbers", () => {
    expect(interpolate("{count} items", { count: 0 })).toBe("0 items");
  });

  it("leaves unknown placeholders intact", () => {
    expect(interpolate("Hello {name}", { other: "x" })).toBe("Hello {name}");
  });

  it("ignores inherited object keys", () => {
    expect(interpolate("Hello {toString}", { name: "x" })).toBe(
      "Hello {toString}",
    );
  });
});

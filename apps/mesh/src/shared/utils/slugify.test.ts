import { describe, expect, it } from "bun:test";
import { slugify } from "./slugify";

describe("slugify", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(slugify("My Cool Server")).toBe("my-cool-server");
  });

  it("replaces forward slashes with hyphens", () => {
    expect(slugify("deco/vtex")).toBe("deco-vtex");
  });

  it("strips special characters not in the allowed set", () => {
    expect(slugify("Server @ v1.0!")).toBe("server-v10");
  });

  it("collapses runs of separators into a single hyphen", () => {
    expect(slugify("a   b__c--d")).toBe("a-b-c-d");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  -Hello World-  ")).toBe("hello-world");
  });

  it("returns an empty string when input has no sluggable characters", () => {
    expect(slugify("@@@")).toBe("");
  });
});

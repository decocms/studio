import { describe, expect, it } from "bun:test";
import { blockLabel } from "./hosted-reconcile";

describe("the reconcile question names a block in words, never by its raw key", () => {
  it("a block's own name", () => {
    expect(blockLabel("Header-a1b2c3d4e5", { name: "Main header" })).toBe(
      "Main header",
    );
  });

  it("a blog post by its title (its `name` is its key)", () => {
    const key = "collections/blog/posts/3fa9c1b2e4d5";
    expect(blockLabel(key, { name: key, post: { title: "Summer sale" } })).toBe(
      "Summer sale",
    );
  });

  it("a category or an author by its name", () => {
    const key = "collections/blog/categories/aa11bb22cc33";
    expect(blockLabel(key, { name: key, category: { name: "News" } })).toBe(
      "News",
    );
  });

  it("with no name or title, the key in words", () => {
    expect(blockLabel("Header-a1b2c3d4e5", { title: "" })).toBe("Header");
    expect(blockLabel("pages-Search%20Page-514254", undefined)).toBe(
      "Search Page",
    );
  });

  it("a blog block with no title yet never shows its path", () => {
    const key = "collections/blog/posts/3fa9c1b2e4d5";
    expect(blockLabel(key, { name: key, post: {} })).not.toContain(
      "collections/",
    );
  });
});

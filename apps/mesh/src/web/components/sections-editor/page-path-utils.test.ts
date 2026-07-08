import { describe, expect, it } from "bun:test";
import {
  extractPathParams,
  fillPathTemplate,
  isValidPagePath,
  normalizePagePath,
  splitPathTemplate,
  validatePagePath,
} from "./page-path-utils";

describe("page-path-utils", () => {
  it("normalizePagePath collapses trailing slashes", () => {
    expect(normalizePagePath("/about/")).toBe("/about");
    expect(normalizePagePath("/")).toBe("/");
  });

  it("isValidPagePath rejects unsafe paths", () => {
    expect(isValidPagePath("/about")).toBe(true);
    expect(isValidPagePath("//evil.com")).toBe(false);
    expect(isValidPagePath("/../secret")).toBe(false);
    expect(isValidPagePath("about")).toBe(false);
  });

  it("validatePagePath returns error messages", () => {
    expect(validatePagePath("/about")).toBeNull();
    expect(validatePagePath("//evil.com")).toMatch(/must start with/);
  });

  it("extractPathParams lists param names in order, deduped", () => {
    expect(extractPathParams("/inspira-novo/blog/:slug")).toEqual(["slug"]);
    expect(extractPathParams("/:org/:repo/issues/:id")).toEqual([
      "org",
      "repo",
      "id",
    ]);
    expect(extractPathParams("/:slug/compare/:slug")).toEqual(["slug"]);
    expect(extractPathParams("/about")).toEqual([]);
  });

  it("extractPathParams accepts any segment starting with `:`", () => {
    expect(extractPathParams("/x/:fodase")).toEqual(["fodase"]);
    expect(extractPathParams("/c/:my-category")).toEqual(["my-category"]);
    expect(extractPathParams("/v/:123")).toEqual(["123"]);
  });

  it("splitPathTemplate interleaves text and param tokens", () => {
    expect(splitPathTemplate("/inspira-novo/blog/:slug")).toEqual([
      { type: "text", text: "/inspira-novo/blog/" },
      { type: "param", name: "slug" },
    ]);
    expect(splitPathTemplate("/:org/issues/:id/edit")).toEqual([
      { type: "text", text: "/" },
      { type: "param", name: "org" },
      { type: "text", text: "/issues/" },
      { type: "param", name: "id" },
      { type: "text", text: "/edit" },
    ]);
    expect(splitPathTemplate("/about")).toEqual([
      { type: "text", text: "/about" },
    ]);
  });

  it("fillPathTemplate substitutes provided values, URL-encoded", () => {
    expect(fillPathTemplate("/blog/:slug", { slug: "meu-post" })).toBe(
      "/blog/meu-post",
    );
    expect(fillPathTemplate("/blog/:slug", { slug: "a b/c" })).toBe(
      "/blog/a%20b%2Fc",
    );
    expect(
      fillPathTemplate("/:org/:repo", { org: "deco", repo: "studio" }),
    ).toBe("/deco/studio");
  });

  it("fillPathTemplate keeps tokens for unset or empty values", () => {
    expect(fillPathTemplate("/blog/:slug", {})).toBe("/blog/:slug");
    expect(fillPathTemplate("/blog/:slug", { slug: "  " })).toBe("/blog/:slug");
    expect(fillPathTemplate("/:org/:repo", { org: "deco" })).toBe(
      "/deco/:repo",
    );
  });
});

import { describe, expect, test } from "bun:test";
import {
  comparePageUrl,
  initialComparePath,
} from "./cms-publish-compare-path.ts";

const SITE = "https://www.example.com";

describe("initialComparePath", () => {
  test("a static page renders its own path", () => {
    expect(initialComparePath({ kind: "page", pagePath: "/sale" }, null)).toBe(
      "/sale",
    );
  });

  test("global blocks and site settings render the home page", () => {
    expect(initialComparePath({ kind: "block", pagePath: null }, null)).toBe(
      "/",
    );
  });

  test("a page without a path asks for one", () => {
    expect(initialComparePath({ kind: "page", pagePath: null }, null)).toBe("");
    expect(initialComparePath({ kind: "page", pagePath: "" }, null)).toBe("");
  });

  test("a dynamic page reuses the last preview's values for the same template", () => {
    expect(
      initialComparePath(
        { kind: "page", pagePath: "/blog/:slug" },
        { path: "/blog/:slug", pageKey: null, params: { slug: "hello" } },
      ),
    ).toBe("/blog/hello");
  });

  test("a dynamic page asks for a path when the last preview was another page or incomplete", () => {
    expect(
      initialComparePath({ kind: "page", pagePath: "/blog/:slug" }, null),
    ).toBe("");
    expect(
      initialComparePath(
        { kind: "page", pagePath: "/blog/:slug" },
        { path: "/:slug/p", pageKey: null, params: { slug: "hello" } },
      ),
    ).toBe("");
    expect(
      initialComparePath(
        { kind: "page", pagePath: "/:category/:slug" },
        { path: "/:category/:slug", pageKey: null, params: { category: "a" } },
      ),
    ).toBe("");
  });
});

describe("comparePageUrl", () => {
  test("resolves a path against the live site", () => {
    expect(comparePageUrl(SITE, "/sale?x=1")?.toString()).toBe(
      `${SITE}/sale?x=1`,
    );
  });

  test("adds the leading slash and trims", () => {
    expect(comparePageUrl(SITE, "  sale ")?.toString()).toBe(`${SITE}/sale`);
  });

  test("never resolves off the live site's origin", () => {
    expect(comparePageUrl(SITE, "//elsewhere.example/x")).toBeNull();
    expect(comparePageUrl(SITE, "https://elsewhere.example/x")?.origin).toBe(
      SITE,
    );
  });

  test("empty or still-patterned paths are not renderable", () => {
    expect(comparePageUrl(SITE, "")).toBeNull();
    expect(comparePageUrl(SITE, "   ")).toBeNull();
    expect(comparePageUrl(SITE, "/blog/:slug")).toBeNull();
    expect(comparePageUrl(SITE, "/*")).toBeNull();
  });

  test("an unparsable site origin is not renderable", () => {
    expect(comparePageUrl("not a url", "/sale")).toBeNull();
  });
});

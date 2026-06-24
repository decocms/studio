import { describe, expect, it } from "bun:test";
import {
  applyBlogPageSlug,
  buildBlogPostPreviewUrl,
  findBlogPageSlug,
  firstCategorySlug,
} from "./blog-preview-url";

describe("findBlogPageSlug", () => {
  it("reads pageSlug from the blog app block", () => {
    const decofile = {
      blog: {
        __resolveType: "site/apps/deco/blog.ts",
        pageSlug: "/blogteste/:category/:slug",
      },
    };
    expect(findBlogPageSlug(decofile)).toBe("/blogteste/:category/:slug");
  });

  it("ignores collection blocks and non-blog apps", () => {
    const decofile = {
      "collections/blog/posts/abc": {
        __resolveType: "blog/loaders/Blogpost.ts",
        pageSlug: "/should-not-use",
      },
      "deco-vtex": { __resolveType: "site/apps/deco/vtex.ts" },
    };
    expect(findBlogPageSlug(decofile)).toBeNull();
  });

  it("returns null when the blog app has no pageSlug", () => {
    const decofile = {
      blog: { __resolveType: "site/apps/deco/blog.ts", postsPerPage: 10 },
    };
    expect(findBlogPageSlug(decofile)).toBeNull();
  });
});

describe("firstCategorySlug", () => {
  it("returns the first category slug", () => {
    expect(
      firstCategorySlug({ categories: [{ name: "News", slug: "news" }] }),
    ).toBe("news");
  });

  it("returns empty string when there are no categories", () => {
    expect(firstCategorySlug({ categories: [] })).toBe("");
    expect(firstCategorySlug({})).toBe("");
  });
});

describe("applyBlogPageSlug", () => {
  it("substitutes category and slug", () => {
    expect(
      applyBlogPageSlug("/blogteste/:category/:slug", {
        category: "news",
        slug: "my-post",
      }),
    ).toBe("/blogteste/news/my-post");
  });

  it("url-encodes param values", () => {
    expect(
      applyBlogPageSlug("/blog/:slug", { category: "", slug: "hello world" }),
    ).toBe("/blog/hello%20world");
  });

  it("supports optional params", () => {
    expect(
      applyBlogPageSlug("/blog/:category?/:slug?", {
        category: "news",
        slug: "my-post",
      }),
    ).toBe("/blog/news/my-post");
  });

  it("returns null when a required param is missing", () => {
    expect(
      applyBlogPageSlug("/blog/:category/:slug", {
        category: "",
        slug: "my-post",
      }),
    ).toBeNull();
    expect(
      applyBlogPageSlug("/blog/:category/:slug", {
        category: "news",
        slug: "",
      }),
    ).toBeNull();
  });

  it("leaves templates without params untouched", () => {
    expect(applyBlogPageSlug("/blog", { category: "", slug: "" })).toBe(
      "/blog",
    );
  });
});

describe("buildBlogPostPreviewUrl", () => {
  const decofile = {
    blog: {
      __resolveType: "site/apps/deco/blog.ts",
      pageSlug: "/blogteste/:category/:slug",
    },
  };

  it("builds an absolute preview url", () => {
    expect(
      buildBlogPostPreviewUrl({
        decofile,
        post: { slug: "my-post", categories: [{ slug: "news" }] },
        previewBaseUrl: "https://abc.preview.example.com",
      }),
    ).toBe("https://abc.preview.example.com/blogteste/news/my-post");
  });

  it("returns null without a preview origin", () => {
    expect(
      buildBlogPostPreviewUrl({
        decofile,
        post: { slug: "my-post", categories: [{ slug: "news" }] },
        previewBaseUrl: null,
      }),
    ).toBeNull();
  });

  it("returns null when a required param is missing", () => {
    expect(
      buildBlogPostPreviewUrl({
        decofile,
        post: { slug: "my-post", categories: [] },
        previewBaseUrl: "https://abc.preview.example.com",
      }),
    ).toBeNull();
  });

  it("returns null when there is no blog app block", () => {
    expect(
      buildBlogPostPreviewUrl({
        decofile: {},
        post: { slug: "my-post" },
        previewBaseUrl: "https://abc.preview.example.com",
      }),
    ).toBeNull();
  });
});

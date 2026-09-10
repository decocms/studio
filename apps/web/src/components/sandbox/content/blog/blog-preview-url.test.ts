import { describe, expect, it } from "bun:test";
import {
  applyBlogCategorySlug,
  applyBlogPageSlug,
  buildBlogCategoryPreviewUrl,
  buildBlogPostPreviewUrl,
  findBlogCategorySlug,
  findBlogPageSlug,
  firstCategorySlug,
} from "./blog-preview-url";

const DRAFT_POINTER = "api.deco.cx/api/acme/decofile/vm-1/main?token=t@abc123";

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

  it("falls back to the blog post Page block when the app omits pageSlug", () => {
    // Bagaggio shape: app block has no route props; the route is a Page block.
    const decofile = {
      "deco-blog": { __resolveType: "site/apps/deco/blog.ts" },
      "pages-blog-slug-66284": {
        __resolveType: "website/pages/Page.tsx",
        name: "Blog Post",
        path: "/blog/:slug",
        sections: [
          { __resolveType: "site/sections/Blog/BlogPostPage.tsx" },
          { __resolveType: "blog/loaders/BlogPostItem.ts" },
        ],
      },
    };
    expect(findBlogPageSlug(decofile)).toBe("/blog/:slug");
  });

  it("prefers the app's pageSlug over the Page block fallback", () => {
    const decofile = {
      blog: {
        __resolveType: "site/apps/deco/blog.ts",
        pageSlug: "/blogteste/:slug",
      },
      "pages-blog-slug-66284": {
        __resolveType: "website/pages/Page.tsx",
        path: "/blog/:slug",
        sections: [{ __resolveType: "site/sections/Blog/BlogPostPage.tsx" }],
      },
    };
    expect(findBlogPageSlug(decofile)).toBe("/blogteste/:slug");
  });

  it("does not treat the category page as the post page", () => {
    const decofile = {
      "deco-blog": { __resolveType: "site/apps/deco/blog.ts" },
      "pages-Blog Categoria-929386": {
        __resolveType: "website/pages/Page.tsx",
        path: "/blog/categoria/:categoria",
        sections: [
          { __resolveType: "site/sections/Blog/BlogCategoryPage.tsx" },
          { __resolveType: "site/sections/Blog/BlogCategoryHeader.tsx" },
        ],
      },
    };
    expect(findBlogPageSlug(decofile)).toBeNull();
  });
});

describe("findBlogCategorySlug", () => {
  it("reads categorySlug from the blog app block", () => {
    const decofile = {
      blog: {
        __resolveType: "site/apps/deco/blog.ts",
        pageSlug: "/blog/:category/:slug",
        categorySlug: "/blog/:category",
      },
    };
    expect(findBlogCategorySlug(decofile)).toBe("/blog/:category");
  });

  it("returns null when categorySlug is not set", () => {
    const decofile = {
      blog: {
        __resolveType: "site/apps/deco/blog.ts",
        pageSlug: "/blog/:category/:slug",
      },
    };
    expect(findBlogCategorySlug(decofile)).toBeNull();
  });

  it("falls back to the category Page block, skipping the paginated variant", () => {
    const decofile = {
      "deco-blog": { __resolveType: "site/apps/deco/blog.ts" },
      "pages-Blog Categoria-929386": {
        __resolveType: "website/pages/Page.tsx",
        path: "/blog/categoria/:categoria",
        sections: [
          { __resolveType: "site/sections/Blog/BlogCategoryPage.tsx" },
        ],
      },
      "pages-Blog Categoria Paginada-803419": {
        __resolveType: "website/pages/Page.tsx",
        path: "/blog/categoria/:categoria/page/:page",
        sections: [
          { __resolveType: "site/sections/Blog/BlogCategoryPage.tsx" },
        ],
      },
    };
    expect(findBlogCategorySlug(decofile)).toBe("/blog/categoria/:categoria");
  });
});

describe("applyBlogCategorySlug", () => {
  it("substitutes the category slug into a :category param", () => {
    expect(applyBlogCategorySlug("/blog/:category", "news")).toBe("/blog/news");
  });

  it("substitutes :slug and :categorySlug params too", () => {
    expect(applyBlogCategorySlug("/blog/cat/:slug", "news")).toBe(
      "/blog/cat/news",
    );
    expect(applyBlogCategorySlug("/blog/:categorySlug?", "news")).toBe(
      "/blog/news",
    );
  });

  it("substitutes the pt-BR :categoria param", () => {
    expect(applyBlogCategorySlug("/blog/categoria/:categoria", "moda")).toBe(
      "/blog/categoria/moda",
    );
  });

  it("url-encodes the slug", () => {
    expect(applyBlogCategorySlug("/blog/:category", "a b")).toBe("/blog/a%20b");
  });

  it("returns a param-less template unchanged (static listing page)", () => {
    expect(applyBlogCategorySlug("/blog", "")).toBe("/blog");
  });

  it("returns null when a param is present but the slug is missing", () => {
    expect(applyBlogCategorySlug("/blog/:category", "")).toBeNull();
  });
});

describe("buildBlogCategoryPreviewUrl", () => {
  const decofile = {
    blog: {
      __resolveType: "site/apps/deco/blog.ts",
      categorySlug: "/blog/:category",
    },
  };

  it("builds an absolute category preview url", () => {
    expect(
      buildBlogCategoryPreviewUrl({
        decofile,
        category: { slug: "news" },
        previewBaseUrl: "https://abc.preview.example.com",
      }),
    ).toBe("https://abc.preview.example.com/blog/news");
  });

  it("returns null without a preview origin", () => {
    expect(
      buildBlogCategoryPreviewUrl({
        decofile,
        category: { slug: "news" },
        previewBaseUrl: null,
      }),
    ).toBeNull();
  });

  it("returns null when categorySlug is not configured", () => {
    expect(
      buildBlogCategoryPreviewUrl({
        decofile: {
          blog: {
            __resolveType: "site/apps/deco/blog.ts",
            pageSlug: "/blog/:category/:slug",
          },
        },
        category: { slug: "news" },
        previewBaseUrl: "https://abc.preview.example.com",
      }),
    ).toBeNull();
  });

  it("returns null when the category has no slug", () => {
    expect(
      buildBlogCategoryPreviewUrl({
        decofile,
        category: {},
        previewBaseUrl: "https://abc.preview.example.com",
      }),
    ).toBeNull();
  });

  it("carries the fast-preview draft pointer so the link shows unpublished edits", () => {
    const url = new URL(
      buildBlogCategoryPreviewUrl({
        decofile,
        category: { slug: "news" },
        previewBaseUrl: "https://abc.preview.example.com",
        draftPointer: DRAFT_POINTER,
      })!,
    );
    expect(url.pathname).toBe("/blog/news");
    expect(url.searchParams.get("__draft")).toBe(DRAFT_POINTER);
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

  it("builds the url from the Page block when the app omits pageSlug", () => {
    expect(
      buildBlogPostPreviewUrl({
        decofile: {
          "deco-blog": { __resolveType: "site/apps/deco/blog.ts" },
          "pages-blog-slug-66284": {
            __resolveType: "website/pages/Page.tsx",
            path: "/blog/:slug",
            sections: [
              { __resolveType: "site/sections/Blog/BlogPostPage.tsx" },
            ],
          },
        },
        post: { slug: "my-post", categories: [] },
        previewBaseUrl: "https://abc.preview.example.com",
      }),
    ).toBe("https://abc.preview.example.com/blog/my-post");
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

  it("carries the fast-preview draft pointer so the link shows unpublished edits", () => {
    const url = new URL(
      buildBlogPostPreviewUrl({
        decofile,
        post: { slug: "my-post", categories: [{ slug: "news" }] },
        previewBaseUrl: "https://abc.preview.example.com",
        draftPointer: DRAFT_POINTER,
      })!,
    );
    expect(url.pathname).toBe("/blogteste/news/my-post");
    expect(url.searchParams.get("__draft")).toBe(DRAFT_POINTER);
  });

  it("leaves the url alone when there is no draft grant (sandbox session)", () => {
    expect(
      buildBlogPostPreviewUrl({
        decofile,
        post: { slug: "my-post", categories: [{ slug: "news" }] },
        previewBaseUrl: "https://abc.preview.example.com",
        draftPointer: null,
      }),
    ).toBe("https://abc.preview.example.com/blogteste/news/my-post");
  });
});

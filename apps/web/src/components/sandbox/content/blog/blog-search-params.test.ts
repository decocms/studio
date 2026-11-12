import { describe, expect, test } from "bun:test";
import {
  blogDeepLinkTarget,
  blogViewFallbackSearch,
  visibleBlogCollection,
} from "./blog-search-params";

/**
 * The context tab is the one collection an org can turn off, and
 * `?blogCollection=` puts it in the URL — so the cases that matter are a stale
 * link and an admin flipping the flag while someone is standing on it.
 */
describe("visibleBlogCollection", () => {
  test("sends someone standing on the context tab back to posts", () => {
    expect(visibleBlogCollection("context", false)).toBe("posts");
  });

  test("leaves the context tab alone when the org turned it on", () => {
    expect(visibleBlogCollection("context", true)).toBe("context");
  });

  test("never touches a collection the flag has nothing to do with", () => {
    for (const blogAi of [true, false]) {
      expect(visibleBlogCollection("posts", blogAi)).toBe("posts");
      expect(visibleBlogCollection("authors", blogAi)).toBe("authors");
      expect(visibleBlogCollection("categories", blogAi)).toBe("categories");
      expect(visibleBlogCollection("post-schedule", blogAi)).toBe(
        "post-schedule",
      );
    }
  });
});

/**
 * The Blog Manager's "Editar no Studio" link still points at the Site Editor,
 * which now has to hand it on. Getting this wrong strands the link on a page
 * that no longer lists blog content at all.
 */
describe("blogDeepLinkTarget", () => {
  test("ignores a link that names no blog collection", () => {
    expect(blogDeepLinkTarget({})).toBeNull();
    expect(blogDeepLinkTarget({ contentCollection: "pages" })).toBeNull();
    expect(
      blogDeepLinkTarget({ contentCollection: "pages", contentItem: "x" }),
    ).toBeNull();
  });

  test("resolves a post to its id, from either block form", () => {
    expect(
      blogDeepLinkTarget({
        contentCollection: "posts",
        contentItem: "collections/blog/posts/abc123",
      }),
    ).toEqual({ collection: "posts", postId: "abc123" });
    // The same post as a draft lives under a different prefix, same id.
    expect(
      blogDeepLinkTarget({
        contentCollection: "posts",
        contentItem: "blog-manager/posts/abc123",
      }),
    ).toEqual({ collection: "posts", postId: "abc123" });
  });

  test("a post link with no item opens the post list, not a missing post", () => {
    expect(blogDeepLinkTarget({ contentCollection: "posts" })).toEqual({
      collection: "posts",
    });
  });

  test("other collections carry the block key, which is their identity", () => {
    expect(
      blogDeepLinkTarget({
        contentCollection: "categories",
        contentItem: "collections/blog/categories/news",
      }),
    ).toEqual({
      collection: "categories",
      item: "collections/blog/categories/news",
    });
  });
});

describe("blogViewFallbackSearch", () => {
  test("authors and categories keep their record, the Content tab's key too", () => {
    expect(
      blogViewFallbackSearch({
        blogCollection: "categories",
        blogItem: "collections/blog/categories/news",
      }),
    ).toEqual({
      contentCollection: "categories",
      contentItem: "collections/blog/categories/news",
    });
    expect(blogViewFallbackSearch({ blogCollection: "authors" })).toEqual({
      contentCollection: "authors",
    });
  });

  test("the rest opens the posts list", () => {
    expect(blogViewFallbackSearch({})).toEqual({ contentCollection: "posts" });
    expect(blogViewFallbackSearch({ blogCollection: "context" })).toEqual({
      contentCollection: "posts",
    });
    expect(
      blogViewFallbackSearch({
        blogCollection: "post-schedule",
        blogItem: "x",
      }),
    ).toEqual({ contentCollection: "posts" });
  });
});

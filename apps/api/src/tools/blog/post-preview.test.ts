import { describe, expect, test } from "bun:test";
import { postPreviewUrls } from "./post-preview";

const POINTER =
  "studio.example.com/api/acme/decofile/vm-1/blog-a?token=t@abc123";

const blogApp = {
  blog: {
    __resolveType: "site/apps/deco/blog.ts",
    pageSlug: "/blog/:slug",
  },
};

const post = (slug: string) => ({ title: slug, slug, sections: [] });

function urls(
  decofile: Record<string, unknown>,
  overrides: Partial<Parameters<typeof postPreviewUrls>[0]> = {},
) {
  return postPreviewUrls({
    decofile,
    meta: null,
    previewBaseUrl: "https://acme.deco.site",
    postId: "a",
    exemplarSlugs: [],
    draftPointer: POINTER,
    ...overrides,
  });
}

describe("postPreviewUrls", () => {
  test("a planning post renders at its route, pulling the branch", () => {
    const { url, reason } = urls({
      ...blogApp,
      "blog-manager/posts/a": {
        name: "blog-manager/posts/a",
        post: post("guia"),
      },
    });
    expect(reason).toBeNull();
    const parsed = new URL(url ?? "");
    expect(parsed.origin + parsed.pathname).toBe(
      "https://acme.deco.site/blog/guia",
    );
    expect(parsed.searchParams.get("__draft")).toBe(POINTER);
  });

  test("a post already promoted renders too", () => {
    expect(
      urls({
        ...blogApp,
        "collections/blog/posts/a": {
          __resolveType: "blog/loaders/Blogpost.ts",
          post: post("guia"),
        },
      }).url,
    ).toContain("/blog/guia");
  });

  test("the examples render published, never the branch", () => {
    const { exemplars } = urls(
      {
        ...blogApp,
        "blog-manager/posts/a": { post: post("guia") },
        "collections/blog/posts/x": {
          __resolveType: "blog/loaders/Blogpost.ts",
          post: post("exemplo"),
        },
      },
      { exemplarSlugs: ["exemplo", "sumiu"] },
    );
    expect(exemplars).toHaveLength(1);
    expect(new URL(exemplars[0]?.url ?? "").searchParams.get("__draft")).toBe(
      "off",
    );
  });

  test("says why there is no address", () => {
    expect(urls(blogApp, { previewBaseUrl: null }).reason).toBe(
      "no-preview-server",
    );
    expect(urls(blogApp).reason).toBe("no-post");
    expect(
      urls({ "blog-manager/posts/a": { post: post("guia") } }).reason,
    ).toBe("no-route");
  });
});

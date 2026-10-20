import { describe, expect, test } from "bun:test";
import { projectPlanningPostsForPreview } from "./blog-draft-projection";

const project = (doc: unknown): Record<string, unknown> =>
  JSON.parse(projectPlanningPostsForPreview(JSON.stringify(doc)));

describe("projectPlanningPostsForPreview", () => {
  test("exposes a planning post as a renderable live block, forced published", () => {
    const out = project({
      "blog-manager/posts/abc": {
        name: "blog-manager/posts/abc",
        post: { title: "Guia", slug: "guia", status: "awaiting_review" },
      },
    });
    expect(out["collections/blog/posts/abc"]).toEqual({
      name: "collections/blog/posts/abc",
      __resolveType: "blog/loaders/Blogpost.ts",
      post: { title: "Guia", slug: "guia", status: "published" },
    });
    // The planning block is left in place; only an extra live block is added.
    expect(out["blog-manager/posts/abc"]).toBeDefined();
  });

  test("reuses the resolveType the site's own posts already use", () => {
    const out = project({
      "collections/blog/posts/live": {
        __resolveType: "site/loaders/BlogPost.ts",
        post: { slug: "live", status: "published" },
      },
      "blog-manager/posts/abc": {
        post: { slug: "guia", status: "draft" },
      },
    });
    expect(
      (out["collections/blog/posts/abc"] as Record<string, unknown>)
        .__resolveType,
    ).toBe("site/loaders/BlogPost.ts");
  });

  test("skips archived (soft-deleted) posts and slug-less posts", () => {
    const out = project({
      "blog-manager/posts/arch": {
        post: { slug: "x", status: "archived" },
      },
      "blog-manager/posts/noslug": {
        post: { title: "No slug", status: "draft" },
      },
    });
    expect(out["collections/blog/posts/arch"]).toBeUndefined();
    expect(out["collections/blog/posts/noslug"]).toBeUndefined();
  });

  test("does not overwrite an existing live post at the same id", () => {
    const doc = {
      "collections/blog/posts/abc": {
        __resolveType: "blog/loaders/Blogpost.ts",
        post: { slug: "real", status: "published" },
      },
      "blog-manager/posts/abc": {
        post: { slug: "planning", status: "draft" },
      },
    };
    const out = project(doc);
    expect(
      (out["collections/blog/posts/abc"] as Record<string, unknown>).post,
    ).toEqual({ slug: "real", status: "published" });
  });

  test("returns the input unchanged when there is nothing to project", () => {
    const json = JSON.stringify({
      "collections/blog/posts/a": {
        __resolveType: "blog/loaders/Blogpost.ts",
        post: { slug: "a" },
      },
      "blog-manager-brand": { companyName: "X" },
    });
    expect(projectPlanningPostsForPreview(json)).toBe(json);
  });

  test("tolerates malformed input", () => {
    expect(projectPlanningPostsForPreview("not json")).toBe("not json");
    expect(projectPlanningPostsForPreview("[]")).toBe("[]");
  });
});

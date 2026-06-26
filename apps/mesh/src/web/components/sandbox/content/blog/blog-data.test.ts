import { describe, expect, test } from "bun:test";
import {
  addCategoryToPost,
  blockComponentName,
  buildBlogBlock,
  discoverBlogBlockTypes,
  listPostsWithMeta,
  replaceCategoryOnPost,
} from "./blog-data";
import type { LiveMeta } from "@/web/components/sections-editor/resolve-schema";

/** Build a decofile keyed by post block id, from `{ slug → payload }`. */
function decofileWithPosts(
  posts: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, payload] of Object.entries(posts)) {
    out[key] = buildBlogBlock(key, "posts", payload);
  }
  return out;
}

function metaWith(resolveTypes: string[]): LiveMeta {
  const group: Record<string, { $ref?: string }> = {};
  for (const rt of resolveTypes) group[rt] = {};
  return {
    manifest: { blocks: { sections: group } },
    schema: {},
  };
}

/** Build a LiveMeta where each resolveType points at a $ref with explicit
 *  schema metadata (title/description/icon). Mirrors how `@title` / `@icon`
 *  JSDoc on a section flows through the manifest in production. */
function metaWithSchemas(
  entries: Array<{
    resolveType: string;
    title?: string;
    description?: string;
    icon?: string;
  }>,
): LiveMeta {
  const group: Record<string, { $ref?: string }> = {};
  const definitions: Record<string, Record<string, unknown>> = {};
  for (const { resolveType, ...md } of entries) {
    const refKey = `Def_${Object.keys(definitions).length}`;
    group[resolveType] = { $ref: `#/definitions/${refKey}` };
    definitions[refKey] = md;
  }
  return {
    manifest: { blocks: { sections: group } },
    schema: { definitions },
  };
}

describe("blockComponentName", () => {
  test("extracts from standard blog block paths", () => {
    expect(blockComponentName("blog/sections/blocks/Paragraph.tsx")).toBe(
      "Paragraph",
    );
  });

  test("extracts from site-specific blog block paths", () => {
    expect(blockComponentName("site/sections/Blog/Post/Paragraph.tsx")).toBe(
      "Paragraph",
    );
    expect(blockComponentName("site/sections/Blog/Post/ProductCard.tsx")).toBe(
      "ProductCard",
    );
  });

  test("strips .ts and .jsx extensions", () => {
    expect(blockComponentName("blog/sections/blocks/Code.ts")).toBe("Code");
    expect(blockComponentName("blog/sections/blocks/Video.jsx")).toBe("Video");
  });
});

describe("discoverBlogBlockTypes", () => {
  test("picks up site/sections/Blog/Post/* blocks (Deno site convention)", () => {
    const out = discoverBlogBlockTypes(
      metaWith([
        "site/sections/Blog/Post/CustomParagraph.tsx",
        "site/sections/Header.tsx",
      ]),
    );
    expect(out.map((b) => b.resolveType)).toEqual([
      "site/sections/Blog/Post/CustomParagraph.tsx",
    ]);
  });

  test("picks up deco-cms/blog app blocks", () => {
    const out = discoverBlogBlockTypes(
      metaWith(["blog/sections/blocks/Paragraph.tsx"]),
    );
    expect(out.map((b) => b.resolveType)).toEqual([
      "blog/sections/blocks/Paragraph.tsx",
    ]);
  });

  test("dedupes and sorts by title", () => {
    const out = discoverBlogBlockTypes(
      metaWith([
        "site/sections/Blog/Post/Zeta.tsx",
        "blog/sections/blocks/Alpha.tsx",
        "site/sections/Blog/Post/Zeta.tsx",
      ]),
    );
    expect(out.map((b) => b.title)).toEqual(["Alpha", "Zeta"]);
  });

  test("tags source as 'app' for blog/sections/blocks and 'site' otherwise", () => {
    const out = discoverBlogBlockTypes(
      metaWith([
        "blog/sections/blocks/Paragraph.tsx",
        "site/sections/Blog/Post/Paragraph.tsx",
      ]),
    );
    const bySource = Object.fromEntries(
      out.map((b) => [b.resolveType, b.source]),
    );
    expect(bySource["blog/sections/blocks/Paragraph.tsx"]).toBe("app");
    expect(bySource["site/sections/Blog/Post/Paragraph.tsx"]).toBe("site");
  });

  test("known component names get catalog defaults (title, description, icon)", () => {
    const paragraph = discoverBlogBlockTypes(
      metaWith(["site/sections/Blog/Post/Paragraph.tsx"]),
    )[0]!;
    expect(paragraph.title).toBe("Paragraph");
    expect(paragraph.description).toBe("Rich text content");
    expect(paragraph.iconName).toBe("Pilcrow01");
  });

  test("unknown component names get fallback icon and no description", () => {
    const custom = discoverBlogBlockTypes(
      metaWith(["site/sections/Blog/Post/MyWeirdBlock.tsx"]),
    )[0]!;
    expect(custom.title).toBe("MyWeirdBlock");
    expect(custom.description).toBeUndefined();
    expect(custom.iconName).toBe("Box");
  });

  test("app blocks: catalog wins over schema title/description/icon", () => {
    const block = discoverBlogBlockTypes(
      metaWithSchemas([
        {
          resolveType: "blog/sections/blocks/BlockImage.tsx",
          title: "BlockImage",
          description: "raw schema description",
          icon: "SomeOtherIcon",
        },
      ]),
    )[0]!;
    expect(block.title).toBe("Image");
    expect(block.description).toBe("Image with optional caption");
    expect(block.iconName).toBe("Image01");
  });

  test("site blocks: @title and @description from schema win over catalog", () => {
    const block = discoverBlogBlockTypes(
      metaWithSchemas([
        {
          resolveType: "site/sections/Blog/Post/Paragraph.tsx",
          title: "My fancy paragraph",
          description: "Custom description from the site",
        },
      ]),
    )[0]!;
    expect(block.title).toBe("My fancy paragraph");
    expect(block.description).toBe("Custom description from the site");
  });

  test("site blocks: @icon as URL is exposed as iconUrl, not iconName", () => {
    const out = discoverBlogBlockTypes(
      metaWithSchemas([
        {
          resolveType: "site/sections/Blog/Post/CustomA.tsx",
          icon: "https://example.com/icon.svg",
        },
        {
          resolveType: "site/sections/Blog/Post/CustomB.tsx",
          icon: "data:image/svg+xml;base64,PHN2Zy8+",
        },
        {
          resolveType: "site/sections/Blog/Post/CustomC.tsx",
          icon: "/static/icon.png",
        },
      ]),
    );
    expect(out.map((b) => b.iconUrl)).toEqual([
      "https://example.com/icon.svg",
      "data:image/svg+xml;base64,PHN2Zy8+",
      "/static/icon.png",
    ]);
  });

  test("site blocks: @icon as plain string is treated as untitled icon name", () => {
    const block = discoverBlogBlockTypes(
      metaWithSchemas([
        {
          resolveType: "site/sections/Blog/Post/CustomD.tsx",
          icon: "Star01",
        },
      ]),
    )[0]!;
    expect(block.iconName).toBe("Star01");
    expect(block.iconUrl).toBeUndefined();
  });
});

describe("listPostsWithMeta", () => {
  test("extracts title, slug, date, category slugs and author emails", () => {
    const decofile = decofileWithPosts({
      "collections/blog/posts/a": {
        title: "Hello",
        slug: "hello",
        date: "2024-01-02",
        categories: [{ name: "News", slug: "news" }],
        authors: [{ name: "Ada", email: "ada@x.com" }],
      },
    });
    expect(listPostsWithMeta(decofile)).toEqual([
      {
        key: "collections/blog/posts/a",
        title: "Hello",
        slug: "hello",
        date: "2024-01-02",
        categorySlugs: ["news"],
        authorEmails: ["ada@x.com"],
      },
    ]);
  });

  test("tolerates plain-string categories/authors and falls back to Untitled", () => {
    const decofile = decofileWithPosts({
      "collections/blog/posts/a": {
        categories: ["news", "tips"],
        authors: ["ada@x.com"],
      },
    });
    const [meta] = listPostsWithMeta(decofile);
    expect(meta!.title).toBe("Untitled post");
    expect(meta!.categorySlugs).toEqual(["news", "tips"]);
    expect(meta!.authorEmails).toEqual(["ada@x.com"]);
  });

  test("drops malformed refs without slug/email", () => {
    const decofile = decofileWithPosts({
      "collections/blog/posts/a": {
        title: "P",
        categories: [{ name: "No slug" }, { name: "News", slug: "news" }],
        authors: [{ name: "No email" }],
      },
    });
    const [meta] = listPostsWithMeta(decofile);
    expect(meta!.categorySlugs).toEqual(["news"]);
    expect(meta!.authorEmails).toEqual([]);
  });

  test("ignores non-post blocks", () => {
    const decofile = {
      ...decofileWithPosts({
        "collections/blog/posts/a": { title: "P", slug: "p" },
      }),
      "collections/blog/categories/c": buildBlogBlock(
        "collections/blog/categories/c",
        "categories",
        { name: "News", slug: "news" },
      ),
    };
    expect(listPostsWithMeta(decofile).map((p) => p.key)).toEqual([
      "collections/blog/posts/a",
    ]);
  });
});

describe("addCategoryToPost", () => {
  test("appends a new category and keeps existing ones", () => {
    const payload = { categories: [{ name: "News", slug: "news" }] };
    const next = addCategoryToPost(payload, { name: "Tips", slug: "tips" });
    expect(next.categories).toEqual([
      { name: "News", slug: "news" },
      { name: "Tips", slug: "tips" },
    ]);
  });

  test("initializes categories when the post has none", () => {
    const next = addCategoryToPost(
      { title: "P" },
      { name: "News", slug: "news" },
    );
    expect(next).toEqual({
      title: "P",
      categories: [{ name: "News", slug: "news" }],
    });
  });

  test("is idempotent — adding a present slug does not duplicate", () => {
    const payload = { categories: [{ name: "News", slug: "news" }] };
    const next = addCategoryToPost(payload, { name: "News", slug: "news" });
    expect(next.categories).toEqual([{ name: "News", slug: "news" }]);
  });

  test("does not mutate the input payload", () => {
    const payload = { categories: [{ name: "News", slug: "news" }] };
    addCategoryToPost(payload, { name: "Tips", slug: "tips" });
    expect(payload.categories).toEqual([{ name: "News", slug: "news" }]);
  });
});

describe("replaceCategoryOnPost", () => {
  test("replaces all categories with the chosen one", () => {
    const payload = {
      categories: [
        { name: "News", slug: "news" },
        { name: "Tips", slug: "tips" },
      ],
    };
    const next = replaceCategoryOnPost(payload, {
      name: "Guides",
      slug: "guides",
    });
    expect(next.categories).toEqual([{ name: "Guides", slug: "guides" }]);
  });

  test("sets the category when the post had none", () => {
    const next = replaceCategoryOnPost({}, { name: "News", slug: "news" });
    expect(next.categories).toEqual([{ name: "News", slug: "news" }]);
  });

  test("is a no-op when it already has exactly that category", () => {
    const payload = { categories: [{ name: "News", slug: "news" }] };
    expect(replaceCategoryOnPost(payload, { name: "News", slug: "news" })).toBe(
      payload,
    );
  });
});

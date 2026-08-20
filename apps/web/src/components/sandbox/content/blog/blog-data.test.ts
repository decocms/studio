import { describe, expect, test } from "bun:test";
import {
  addCategoryToPost,
  blockComponentName,
  buildBlogBlock,
  discoverBlogBlockTypes,
  emptyBlogPayload,
  isPostPublished,
  listPostsWithMeta,
  missingPostFields,
  relationPickerState,
  removeCategoryFromPost,
  renameCategoryOnPost,
  replaceCategoryOnPost,
  stampPostModified,
} from "./blog-data";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";

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

describe("isPostPublished", () => {
  test("an unset, empty or non-string status reads as published", () => {
    expect(isPostPublished({})).toBe(true);
    expect(isPostPublished({ status: "" })).toBe(true);
    expect(isPostPublished({ status: null })).toBe(true);
    expect(isPostPublished({ status: 1 })).toBe(true);
  });

  test("only an explicit published status reads as published", () => {
    expect(isPostPublished({ status: "published" })).toBe(true);
    expect(isPostPublished({ status: "draft" })).toBe(false);
  });

  test("statuses the CMS does not edit read as not published", () => {
    expect(isPostPublished({ status: "generating" })).toBe(false);
    expect(isPostPublished({ status: "awaiting_review" })).toBe(false);
    expect(isPostPublished({ status: "archived" })).toBe(false);
  });

  test("is case- and whitespace-sensitive: only the exact value publishes", () => {
    expect(isPostPublished({ status: "Published" })).toBe(false);
    expect(isPostPublished({ status: " published " })).toBe(false);
  });
});

describe("listPostsWithMeta", () => {
  test("reports each post's published state for the status filter", () => {
    const decofile = decofileWithPosts({
      "collections/blog/posts/a": { title: "Live", status: "published" },
      "collections/blog/posts/b": { title: "Draft", status: "draft" },
      "collections/blog/posts/c": { title: "Legacy" },
    });
    // Keyed by title so the assertion doesn't encode the list's own ordering.
    expect(
      Object.fromEntries(
        listPostsWithMeta(decofile).map((p) => [p.title, p.published]),
      ),
    ).toEqual({ Live: true, Draft: false, Legacy: true });
  });

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
        // no excerpt or cover image on this fixture
        missing: ["Excerpt", "Cover image"],
        // no `status` on this fixture — posts predating the field are published
        published: true,
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

describe("missingPostFields", () => {
  test("returns empty for a complete post", () => {
    expect(
      missingPostFields({
        title: "Hello",
        slug: "hello",
        categories: [{ name: "News", slug: "news" }],
        excerpt: "A short summary.",
        image: "https://cdn/cover.jpg",
      }),
    ).toEqual([]);
  });

  test("lists every missing required field in order", () => {
    expect(missingPostFields({})).toEqual([
      "Title",
      "Slug",
      "Category",
      "Excerpt",
      "Cover image",
    ]);
  });

  test("treats whitespace-only strings as missing", () => {
    expect(
      missingPostFields({
        title: "   ",
        slug: "hello",
        categories: [{ slug: "news" }],
        excerpt: "\n\t ",
        image: "https://cdn/cover.jpg",
      }),
    ).toEqual(["Title", "Excerpt"]);
  });

  test("needs at least one category with a slug", () => {
    expect(
      missingPostFields({
        title: "T",
        slug: "s",
        categories: [{ name: "No slug" }],
        excerpt: "e",
        image: "https://cdn/cover.jpg",
      }),
    ).toEqual(["Category"]);
  });

  test("requires a cover image", () => {
    expect(
      missingPostFields({
        title: "T",
        slug: "s",
        categories: ["news"],
        excerpt: "e",
      }),
    ).toEqual(["Cover image"]);
  });

  test("accepts plain-string categories", () => {
    expect(
      missingPostFields({
        title: "T",
        slug: "s",
        categories: ["news"],
        excerpt: "e",
        image: "https://cdn/cover.jpg",
      }),
    ).toEqual([]);
  });
});

describe("relationPickerState", () => {
  const records = [
    {
      key: "collections/blog/authors/a",
      payload: {
        name: "Ada",
        type: "Person",
        email: "ada@x.com",
        jobTitle: "Engineer",
        company: "Acme",
        avatar: "ada.png",
      },
    },
    {
      key: "collections/blog/authors/b",
      payload: { name: "No Mail", email: "" },
    },
  ];
  const args = {
    records,
    valueField: "email",
    toRef: (payload: Record<string, unknown>) => ({ ...payload }),
  };

  test("options are keyed by record key and labeled by name", () => {
    const { options } = relationPickerState({ ...args, selected: [] });
    expect(options).toEqual([
      { value: "collections/blog/authors/a", label: "Ada" },
      { value: "collections/blog/authors/b", label: "No Mail" },
    ]);
  });

  test("resolves a selected ref by its identity field", () => {
    const { selectedValues } = relationPickerState({
      ...args,
      selected: [{ name: "Stale Name", email: "ada@x.com" }],
    });
    expect(selectedValues).toEqual(["collections/blog/authors/a"]);
  });

  test("falls back to the name when the identity field is empty", () => {
    const { selectedValues } = relationPickerState({
      ...args,
      selected: [{ name: "No Mail", email: "" }],
    });
    expect(selectedValues).toEqual(["collections/blog/authors/b"]);
  });

  test("tolerates plain-string refs (categories store bare slugs)", () => {
    const { selectedValues } = relationPickerState({
      records: [
        {
          key: "collections/blog/categories/c",
          payload: { name: "News", slug: "news" },
        },
      ],
      valueField: "slug",
      toRef: (payload: Record<string, unknown>) => ({
        name: payload.name,
        slug: payload.slug,
      }),
      selected: ["news"],
    });
    expect(selectedValues).toEqual(["collections/blog/categories/c"]);
  });

  test("maps picked keys back through toRef — full record for authors", () => {
    const { refsForValues } = relationPickerState({ ...args, selected: [] });
    expect(
      refsForValues([
        "collections/blog/authors/a",
        "collections/blog/authors/b",
      ]),
    ).toEqual([
      {
        name: "Ada",
        type: "Person",
        email: "ada@x.com",
        jobTitle: "Engineer",
        company: "Acme",
        avatar: "ada.png",
      },
      { name: "No Mail", email: "" },
    ]);
  });

  test("keeps unresolvable refs visible and round-trips them unchanged", () => {
    const ghost = { name: "Deleted Author", email: "ghost@x.com" };
    const { options, selectedValues, refsForValues } = relationPickerState({
      ...args,
      selected: [ghost],
    });
    expect(selectedValues).toEqual(["unresolved:0"]);
    expect(options).toContainEqual({
      value: "unresolved:0",
      label: "Deleted Author",
    });
    const refs = refsForValues(["unresolved:0", "collections/blog/authors/a"]);
    expect(refs[0]).toEqual(ghost);
    expect(refs[1]).toEqual(records[0]!.payload);
  });

  test("dedupes refs that resolve to the same record", () => {
    const { selectedValues } = relationPickerState({
      ...args,
      selected: [
        { name: "Ada", email: "ada@x.com" },
        { name: "Ada Again", email: "ada@x.com" },
      ],
    });
    expect(selectedValues).toEqual(["collections/blog/authors/a"]);
  });
});

describe("stampPostModified", () => {
  test("sets dateModified to an ISO date-time, preserving other fields", () => {
    const next = stampPostModified({ title: "P", slug: "p" });
    expect(next.title).toBe("P");
    expect(next.slug).toBe("p");
    expect(typeof next.dateModified).toBe("string");
    const stamp = String(next.dateModified);
    expect(new Date(stamp).toISOString()).toBe(stamp);
  });

  test("does not mutate the input payload", () => {
    const payload = { title: "P" };
    stampPostModified(payload);
    expect(payload).toEqual({ title: "P" });
  });
});

describe("emptyBlogPayload", () => {
  test("new authors default to type Person", () => {
    expect(emptyBlogPayload("authors").type).toBe("Person");
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

describe("renameCategoryOnPost", () => {
  test("rewrites the matching slug and name, preserving others and order", () => {
    const payload = {
      title: "P",
      categories: [
        { name: "News", slug: "news" },
        { name: "Old", slug: "old" },
        { name: "Tips", slug: "tips" },
      ],
    };
    const next = renameCategoryOnPost(payload, "old", {
      name: "Fresh",
      slug: "fresh",
    });
    expect(next.categories).toEqual([
      { name: "News", slug: "news" },
      { name: "Fresh", slug: "fresh" },
      { name: "Tips", slug: "tips" },
    ]);
  });

  test("tolerates plain-string category references", () => {
    const payload = { categories: ["old", "tips"] };
    const next = renameCategoryOnPost(payload, "old", {
      name: "Fresh",
      slug: "fresh",
    });
    expect(next.categories).toEqual([{ name: "Fresh", slug: "fresh" }, "tips"]);
  });

  test("collapses the duplicate when the post already had the new slug", () => {
    const payload = {
      categories: [
        { name: "Old", slug: "old" },
        { name: "Fresh", slug: "fresh" },
      ],
    };
    const next = renameCategoryOnPost(payload, "old", {
      name: "Fresh",
      slug: "fresh",
    });
    expect(next.categories).toEqual([{ name: "Fresh", slug: "fresh" }]);
  });

  test("refreshes the denormalized name when the new slug precedes the old", () => {
    const payload = {
      categories: [
        { name: "Stale", slug: "fresh" },
        { name: "Old", slug: "old" },
      ],
    };
    const next = renameCategoryOnPost(payload, "old", {
      name: "Fresh",
      slug: "fresh",
    });
    expect(next.categories).toEqual([{ name: "Fresh", slug: "fresh" }]);
  });

  test("is a no-op (same reference) when the old slug is absent", () => {
    const payload = { categories: [{ name: "News", slug: "news" }] };
    expect(
      renameCategoryOnPost(payload, "old", { name: "Fresh", slug: "fresh" }),
    ).toBe(payload);
  });

  test("does not mutate the input payload", () => {
    const payload = { categories: [{ name: "Old", slug: "old" }] };
    renameCategoryOnPost(payload, "old", { name: "Fresh", slug: "fresh" });
    expect(payload.categories).toEqual([{ name: "Old", slug: "old" }]);
  });
});

describe("removeCategoryFromPost", () => {
  test("drops the matching category, keeping the rest", () => {
    const payload = {
      title: "P",
      categories: [
        { name: "News", slug: "news" },
        { name: "Old", slug: "old" },
      ],
    };
    const next = removeCategoryFromPost(payload, "old");
    expect(next.categories).toEqual([{ name: "News", slug: "news" }]);
  });

  test("tolerates plain-string category references", () => {
    const payload = { categories: ["news", "old"] };
    const next = removeCategoryFromPost(payload, "old");
    expect(next.categories).toEqual(["news"]);
  });

  test("is a no-op (same reference) when the slug is absent", () => {
    const payload = { categories: [{ name: "News", slug: "news" }] };
    expect(removeCategoryFromPost(payload, "old")).toBe(payload);
  });

  test("does not mutate the input payload", () => {
    const payload = { categories: [{ name: "Old", slug: "old" }] };
    removeCategoryFromPost(payload, "old");
    expect(payload.categories).toEqual([{ name: "Old", slug: "old" }]);
  });
});

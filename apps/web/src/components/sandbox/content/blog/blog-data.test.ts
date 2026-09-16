import { describe, expect, test } from "bun:test";
import {
  blockComponentName,
  blocksPostStatus,
  buildBlogBlock,
  DEFAULT_SCHEDULE_HOUR,
  defaultScheduledDatetime,
  discoverBlogBlockTypes,
  emptyBlogPayload,
  listPostsWithMeta,
  missingPostFields,
  postStatus,
  relationPickerState,
  removeCategoryFromPost,
  renameCategoryOnPost,
  extractBlockProse,
  filledBrandRules,
  normalizeBrandRules,
  selectBrandEvidenceBlocks,
  setPostStatus,
  stampPostModified,
  dedupeSuggestedThemes,
  newIdeaKey,
  scanIdeas,
  IDEA_KEY_PREFIX,
  scanPillars,
  newPillarKey,
  PILLAR_KEY_PREFIX,
  PLANNING_POST_KEY_PREFIX,
  emptyDraftPostPayload,
  planningMeta,
  buildPlanningPostBlock,
  listPlanningPosts,
  listAllPostsWithMeta,
  movePostToStatus,
  planningPostKey,
  livePostKey,
  postIdOfKey,
  buildGeneratedPostPayload,
  buildPostSections,
  citedSections,
  defaultFormatSections,
  missingBrandForGeneration,
  postStructures,
  sectionResolveTypes,
  slugifyTitle,
  uniquePostSlug,
  unknownCitations,
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

describe("listPostsWithMeta", () => {
  test("reports each post's status for the list filter", () => {
    const decofile = decofileWithPosts({
      "collections/blog/posts/a": { title: "Live", status: "published" },
      "collections/blog/posts/b": { title: "Draft", status: "draft" },
      "collections/blog/posts/c": { title: "Legacy" },
      "collections/blog/posts/d": { title: "Planned", status: "scheduled" },
    });
    // Keyed by title so the assertion doesn't encode the list's own ordering.
    expect(
      Object.fromEntries(
        listPostsWithMeta(decofile).map((p) => [p.title, p.status]),
      ),
    ).toEqual({
      Live: "published",
      Draft: "draft",
      Legacy: "published",
      Planned: "scheduled",
    });
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
        // no `scheduledDatetime` on this fixture — the post isn't scheduled
        scheduledDatetime: "",
        categorySlugs: ["news"],
        authorEmails: ["ada@x.com"],
        // no excerpt or cover image on this fixture
        missing: ["Excerpt", "Cover image"],
        // no `status` on this fixture — posts predating the field are published
        status: "published",
        form: "live",
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

const COMPLETE_POST = {
  title: "Hello",
  slug: "hello",
  categories: ["news"],
  excerpt: "A short summary.",
  image: "https://cdn/cover.jpg",
};

describe("blocksPostStatus", () => {
  test("blocks an incomplete post from being published", () => {
    expect(blocksPostStatus({ status: "draft" }, "published")).toBe(true);
  });

  test("blocks scheduling an incomplete post — a live date needs a live post", () => {
    expect(blocksPostStatus({ status: "awaiting_review" }, "scheduled")).toBe(
      true,
    );
    expect(blocksPostStatus({ status: "published" }, "scheduled")).toBe(true);
  });

  test("lets a complete post be scheduled", () => {
    expect(blocksPostStatus({ ...COMPLETE_POST }, "scheduled")).toBe(false);
  });

  test("never blocks pulling a post back to review", () => {
    expect(blocksPostStatus({ status: "published" }, "awaiting_review")).toBe(
      false,
    );
    expect(blocksPostStatus({ status: "scheduled" }, "awaiting_review")).toBe(
      false,
    );
  });

  test("never blocks archiving — archived is not a live state", () => {
    expect(blocksPostStatus({ status: "published" }, "archived")).toBe(false);
    expect(blocksPostStatus({ status: "draft" }, "archived")).toBe(false);
  });

  test("does not block the state the post is already in", () => {
    expect(blocksPostStatus({ status: "published" }, "published")).toBe(false);
  });

  test("allows a complete post to be published", () => {
    expect(
      blocksPostStatus({ status: "draft", ...COMPLETE_POST }, "published"),
    ).toBe(false);
  });
});

describe("postStatus", () => {
  test("reads an unset, empty or non-string status as published", () => {
    expect(postStatus({})).toBe("published");
    expect(postStatus({ status: "" })).toBe("published");
    expect(postStatus({ status: null })).toBe("published");
    expect(postStatus({ status: 1 })).toBe("published");
  });

  test("is case- and whitespace-sensitive: an inexact value is unrecognized", () => {
    expect(postStatus({ status: "Published" })).toBe("awaiting_review");
    expect(postStatus({ status: " published " })).toBe("awaiting_review");
    expect(postStatus({ status: " scheduled " })).toBe("awaiting_review");
  });

  // Every value must round-trip: this is the blog app's own PostStatus union.
  test("reads the six lifecycle states", () => {
    expect(postStatus({ status: "draft" })).toBe("draft");
    expect(postStatus({ status: "generating" })).toBe("generating");
    expect(postStatus({ status: "awaiting_review" })).toBe("awaiting_review");
    expect(postStatus({ status: "scheduled" })).toBe("scheduled");
    expect(postStatus({ status: "published" })).toBe("published");
    expect(postStatus({ status: "archived" })).toBe("archived");
  });

  test("reads the legacy Studio-only names as their app equivalents", () => {
    expect(postStatus({ status: "idea" })).toBe("draft");
    expect(postStatus({ status: "in_review" })).toBe("awaiting_review");
  });

  test("reads an unrecognized status as awaiting_review, never live", () => {
    expect(postStatus({ status: "nonsense" })).toBe("awaiting_review");
  });

  test("reads scheduled from the status alone, with no datetime", () => {
    expect(postStatus({ status: "scheduled" })).toBe("scheduled");
  });
});

describe("defaultScheduledDatetime", () => {
  test("offers the configured hour tomorrow, local time", () => {
    const iso = defaultScheduledDatetime(new Date(2026, 7, 21, 15, 30));
    const parsed = new Date(iso);
    expect(parsed.getDate()).toBe(22);
    expect(parsed.getMonth()).toBe(7);
    expect(parsed.getHours()).toBe(DEFAULT_SCHEDULE_HOUR);
  });

  test("rolls over month and year boundaries", () => {
    const parsed = new Date(defaultScheduledDatetime(new Date(2026, 11, 31)));
    expect(parsed.getFullYear()).toBe(2027);
    expect(parsed.getMonth()).toBe(0);
    expect(parsed.getDate()).toBe(1);
  });
});

describe("setPostStatus", () => {
  const now = new Date(2026, 7, 21, 15, 30);

  test("seeds a go-live instant when scheduling without one", () => {
    const next = setPostStatus({ ...COMPLETE_POST }, "scheduled", now);
    expect(next.status).toBe("scheduled");
    expect(new Date(next.scheduledDatetime as string).getDate()).toBe(22);
  });

  test("keeps an instant the post already carries", () => {
    const existing = new Date(2026, 8, 2, 10).toISOString();
    const next = setPostStatus(
      { ...COMPLETE_POST, scheduledDatetime: existing },
      "scheduled",
      now,
    );
    expect(next.scheduledDatetime).toBe(existing);
  });

  test("replaces an unparseable instant instead of keeping it", () => {
    const next = setPostStatus(
      { scheduledDatetime: "whenever" },
      "scheduled",
      now,
    );
    expect(new Date(next.scheduledDatetime as string).getDate()).toBe(22);
  });

  test("clears the instant when leaving scheduled for review", () => {
    const next = setPostStatus(
      { status: "scheduled", scheduledDatetime: new Date().toISOString() },
      "awaiting_review",
      now,
    );
    expect(next.status).toBe("awaiting_review");
    expect(next.scheduledDatetime).toBe("");
  });

  test("clears the instant when leaving scheduled for published", () => {
    const next = setPostStatus(
      { status: "scheduled", scheduledDatetime: new Date().toISOString() },
      "published",
      now,
    );
    expect(next.status).toBe("published");
    expect(next.scheduledDatetime).toBe("");
  });

  test("never mutates the payload it is given", () => {
    const payload = { status: "draft", title: "Hello" };
    setPostStatus(payload, "scheduled", now);
    expect(payload).toEqual({ status: "draft", title: "Hello" });
  });
});

describe("scanPillars", () => {
  test("reads pillars newest-first with their formats", () => {
    const pillars = scanPillars({
      [`${PILLAR_KEY_PREFIX}a`]: {
        title: "Product updates",
        body: "What shipped.",
        createdAt: "2026-01-01",
        formats: ["Changelog", "Deep dive"],
      },
      [`${PILLAR_KEY_PREFIX}b`]: {
        title: "Customer cases",
        body: "How they win.",
        createdAt: "2026-02-01",
        formats: [],
      },
    });
    expect(pillars.map((p) => p.title)).toEqual([
      "Customer cases",
      "Product updates",
    ]);
    expect(pillars[1]?.formats).toEqual(["Changelog", "Deep dive"]);
  });

  test("leaves the ideas queue alone — those blocks were always ideas", () => {
    const pillars = scanPillars({
      [`${PILLAR_KEY_PREFIX}a`]: { title: "New pillar", createdAt: "2026-02" },
      [`${IDEA_KEY_PREFIX}b`]: { title: "An idea", createdAt: "2026-01" },
    });
    expect(pillars.map((p) => p.title)).toEqual(["New pillar"]);
  });

  test("ignores non-object and unrelated blocks", () => {
    expect(scanPillars({ [`${PILLAR_KEY_PREFIX}x`]: "corrupt" })).toEqual([]);
    expect(scanPillars({ "blog-manager-brand": { title: "nope" } })).toEqual(
      [],
    );
  });
});

describe("newPillarKey", () => {
  test("is under the pillars prefix and unique", () => {
    const a = newPillarKey();
    const b = newPillarKey();
    expect(a.startsWith(PILLAR_KEY_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("emptyDraftPostPayload / planningMeta", () => {
  const now = new Date(2026, 7, 21, 15, 30);

  test("starts a post as a briefing with no body", () => {
    const payload = emptyDraftPostPayload({
      title: "How to read a label",
      planning: { pillarKey: "p1", brief: "Angle." },
      now,
    });
    expect(payload.status).toBe("draft");
    expect(payload.sections).toEqual([]);
    expect(postStatus(payload)).toBe("draft");
    expect(planningMeta(payload).brief).toBe("Angle.");
    expect(planningMeta(payload).pillarKey).toBe("p1");
  });

  test("planningMeta tolerates a missing planning object", () => {
    expect(planningMeta({})).toEqual({});
  });
});

describe("listPlanningPosts / listAllPostsWithMeta", () => {
  test("planning posts are read by prefix and excluded from the live list", () => {
    const decofile = {
      [`${PLANNING_POST_KEY_PREFIX}1`]: buildPlanningPostBlock(
        `${PLANNING_POST_KEY_PREFIX}1`,
        { title: "An idea", status: "draft" },
      ),
      ...decofileWithPosts({
        "collections/blog/posts/2": { title: "Live", status: "published" },
      }),
    };
    expect(listPlanningPosts(decofile).map((p) => p.payload.title)).toEqual([
      "An idea",
    ]);
    // The live-only list never sees planning posts.
    expect(listPostsWithMeta(decofile).map((p) => p.title)).toEqual(["Live"]);
    const all = listAllPostsWithMeta(decofile);
    expect(
      Object.fromEntries(all.map((p) => [p.title, [p.status, p.form]])),
    ).toEqual({
      "An idea": ["draft", "planning"],
      Live: ["published", "live"],
    });
  });
});

describe("movePostToStatus", () => {
  const now = new Date(2026, 7, 21, 15, 30);
  const complete = {
    title: "Hello",
    slug: "hello",
    categories: ["news"],
    excerpt: "A short summary.",
    image: "https://cdn/cover.jpg",
  };

  test("promotes a planning post to a live block, preserving id and slug", () => {
    const key = planningPostKey("abc123");
    const move = movePostToStatus(
      { key, payload: { ...complete, status: "awaiting_review" } },
      "scheduled",
      now,
    );
    const targetKey = livePostKey("abc123");
    expect(move.deletes).toEqual([key]);
    const block = move.writes[targetKey] as Record<string, unknown>;
    expect(block.__resolveType).toBe("blog/loaders/Blogpost.ts");
    const post = block.post as Record<string, unknown>;
    expect(post.slug).toBe("hello");
    expect(post.status).toBe("scheduled");
    expect(typeof post.scheduledDatetime).toBe("string");
  });

  test("demotes a live post back to a planning block with no resolveType", () => {
    const key = livePostKey("abc123");
    const move = movePostToStatus(
      { key, payload: { ...complete, status: "scheduled" } },
      "awaiting_review",
      now,
    );
    const targetKey = planningPostKey("abc123");
    expect(move.deletes).toEqual([key]);
    const block = move.writes[targetKey] as Record<string, unknown>;
    expect("__resolveType" in block).toBe(false);
    const post = block.post as Record<string, unknown>;
    expect(post.status).toBe("awaiting_review");
    expect(post.scheduledDatetime).toBe("");
  });

  test("a within-planning move rewrites in place with nothing to delete", () => {
    const key = planningPostKey("abc123");
    const move = movePostToStatus(
      { key, payload: { title: "T", status: "draft" } },
      "awaiting_review",
      now,
    );
    expect(move.deletes).toEqual([]);
    expect(Object.keys(move.writes)).toEqual([key]);
  });

  test("archiving a live post demotes it, so the site stops rendering it", () => {
    const key = livePostKey("abc123");
    const move = movePostToStatus(
      { key, payload: { ...complete, status: "published" } },
      "archived",
      now,
    );
    const targetKey = planningPostKey("abc123");
    expect(move.deletes).toEqual([key]);
    const block = move.writes[targetKey] as Record<string, unknown>;
    expect("__resolveType" in block).toBe(false);
    expect((block.post as Record<string, unknown>).status).toBe("archived");
  });
});

describe("postIdOfKey", () => {
  test("reads the shared id from either form's key", () => {
    expect(postIdOfKey(planningPostKey("xyz"))).toBe("xyz");
    expect(postIdOfKey(livePostKey("xyz"))).toBe("xyz");
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

describe("normalizeBrandRules", () => {
  test("promotes a legacy flat string to a rule name", () => {
    expect(
      normalizeBrandRules(["Nunca escreva preço em bloco de texto"]),
    ).toEqual([{ name: "Nunca escreva preço em bloco de texto", value: "" }]);
  });

  test("passes a well-formed rule through", () => {
    const rule = { name: "Preços", value: "Use **ProductCard**." };
    expect(normalizeBrandRules([rule])).toEqual([rule]);
  });

  test("handles a list that mixes both shapes — a half-migrated block", () => {
    expect(
      normalizeBrandRules(["antiga", { name: "nova", value: "corpo" }]),
    ).toEqual([
      { name: "antiga", value: "" },
      { name: "nova", value: "corpo" },
    ]);
  });

  test("keeps a rule that has only a body", () => {
    expect(normalizeBrandRules([{ value: "só o corpo" }])).toEqual([
      { name: "", value: "só o corpo" },
    ]);
  });

  test("keeps a blank object — it's a row the user just added", () => {
    expect(normalizeBrandRules([{ name: "", value: "" }])).toEqual([
      { name: "", value: "" },
    ]);
    expect(normalizeBrandRules([{}])).toEqual([{ name: "", value: "" }]);
  });

  test("drops blank legacy strings and anything that isn't an object", () => {
    expect(normalizeBrandRules(["", "   ", null, 42])).toEqual([]);
  });

  test("returns empty for a non-array, including the absent field", () => {
    expect(normalizeBrandRules(undefined)).toEqual([]);
    expect(normalizeBrandRules("nao é lista")).toEqual([]);
    expect(normalizeBrandRules({ name: "solto" })).toEqual([]);
  });
});

describe("extractBlockProse", () => {
  test("drops asset urls, keeps the prose beside them", () => {
    const block = {
      video: { src: "https://player.vimeo.com/progressive_redirect/x.mp4" },
      thumbnail: "https://cdn.example.com/site/2024/banner-mobile.jpg",
      alt: "do rio pro mundo",
    };
    const out = extractBlockProse(block);

    expect(out).toContain("do rio pro mundo");
    expect(out).not.toContain("vimeo");
    expect(out).not.toContain("cdn.example.com");
  });

  test("drops identifiers and dimension labels, not phrases", () => {
    const out = extractBlockProse({
      __resolveType: "site/sections/Layout/Flex.tsx",
      gap: "20px",
      title: "encontre a loja mais próxima de você",
    });

    expect(out).not.toContain("Flex.tsx");
    expect(out).not.toContain("20px");
    expect(out).toContain("encontre a loja mais próxima de você");
  });

  test("keeps the prop name, so the model knows what kind of copy it is", () => {
    expect(extractBlockProse({ alt: "92% de funcionárias" })).toBe(
      "alt: 92% de funcionárias",
    );
  });

  test("keeps html stored as a string", () => {
    const html = "<p>verifique os detalhes direto na sua mochila</p>";
    expect(extractBlockProse({ text: html })).toContain("sua mochila");
  });

  test("drops exact duplicates — a banner repeats across a whole site", () => {
    const out = extractBlockProse([
      { text: "vem pro app e ganhe desconto" },
      { text: "vem pro app e ganhe desconto" },
    ]);
    expect(out.split("\n")).toHaveLength(1);
  });

  test("keeps casing variants — the inconsistency is a fact about the brand", () => {
    const out = extractBlockProse([
      { text: "O custo pode mudar" },
      { text: "o custo pode mudar" },
    ]);
    expect(out.split("\n")).toHaveLength(2);
  });
});

describe("selectBrandEvidenceBlocks", () => {
  test("ranks a prose-heavy page above a url-heavy one", () => {
    const decofile = {
      "pages/plp": {
        path: "/roupas",
        sections: [{ src: "https://cdn.example.com/a-very-long-asset.jpg" }],
      },
      "pages/sobre": {
        path: "/sobre",
        sections: [{ text: "a biodiversidade brasileira acende em nós" }],
      },
    };

    expect(
      selectBrandEvidenceBlocks(decofile, ["pages/plp", "pages/sobre"]).map(
        (b) => b.key,
      ),
    ).toEqual(["pages/sobre", "pages/plp"]);
  });

  test("ranks posts before categories before pages", () => {
    const decofile = {
      ...decofileWithPosts({
        "collections/blog/posts/a": { content: "prose" },
      }),
      "collections/blog/categories/c": buildBlogBlock(
        "collections/blog/categories/c",
        "categories",
        { name: "News", slug: "news" },
      ),
      "pages/home": { path: "/", sections: [] },
    };

    expect(
      selectBrandEvidenceBlocks(decofile, ["pages/home"]).map((b) => b.key),
    ).toEqual([
      "collections/blog/posts/a",
      "collections/blog/categories/c",
      "pages/home",
    ]);
  });

  test("puts the post with the most prose first", () => {
    const decofile = decofileWithPosts({
      "collections/blog/posts/short": { content: "oi" },
      "collections/blog/posts/long": { content: "prosa da marca ".repeat(50) },
    });

    expect(selectBrandEvidenceBlocks(decofile, []).map((b) => b.key)).toEqual([
      "collections/blog/posts/long",
      "collections/blog/posts/short",
    ]);
  });

  test("stops once the char budget is spent instead of sending everything", () => {
    const posts: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 20; i++) {
      posts[`collections/blog/posts/p${i}`] = {
        content: "prosa da marca ".repeat(1_000),
      };
    }

    const selected = selectBrandEvidenceBlocks(decofileWithPosts(posts), []);
    const total = selected.reduce((sum, b) => sum + b.content.length, 0);

    expect(selected.length).toBeLessThan(20);
    expect(total).toBeLessThanOrEqual(60_000);
  });

  test("returns nothing for a site with no content", () => {
    expect(selectBrandEvidenceBlocks({}, [])).toEqual([]);
  });

  test("skips page keys the decofile doesn't have", () => {
    expect(selectBrandEvidenceBlocks({}, ["pages/ghost"])).toEqual([]);
  });
});

describe("scanIdeas", () => {
  test("reads only theme blocks, newest first", () => {
    const ideas = scanIdeas({
      [`${IDEA_KEY_PREFIX}b`]: {
        title: "Segundo",
        body: "briefing b",
        createdAt: "2026-02-01T00:00:00.000Z",
      },
      [`${IDEA_KEY_PREFIX}a`]: {
        title: "Primeiro",
        body: "briefing a",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      "blog-manager-brand": { companyName: "Marca" },
      "collections/blog/posts/x": {
        __resolveType: "blog/loaders/Blogpost.ts",
        post: { title: "Post" },
      },
    });

    expect(ideas.map((idea) => idea.title)).toEqual(["Segundo", "Primeiro"]);
    expect(ideas[0]?.key).toBe(`${IDEA_KEY_PREFIX}b`);
    expect(ideas[1]?.body).toBe("briefing a");
  });

  test("an idea still being written has empty fields, not missing ones", () => {
    const ideas = scanIdeas({ [`${IDEA_KEY_PREFIX}new`]: {} });
    expect(ideas).toEqual([
      {
        key: `${IDEA_KEY_PREFIX}new`,
        title: "",
        body: "",
        pillarKey: undefined,
        createdAt: "",
      },
    ]);
  });

  test("ideas without a date sort last, and ties break by title", () => {
    const dated = "2026-01-01T00:00:00.000Z";
    const ideas = scanIdeas({
      [`${IDEA_KEY_PREFIX}1`]: { title: "Sem data" },
      [`${IDEA_KEY_PREFIX}2`]: { title: "Bravo", createdAt: dated },
      [`${IDEA_KEY_PREFIX}3`]: { title: "Alfa", createdAt: dated },
    });
    expect(ideas.map((idea) => idea.title)).toEqual([
      "Alfa",
      "Bravo",
      "Sem data",
    ]);
  });

  test("ignores a non-object at an idea key", () => {
    expect(scanIdeas({ [`${IDEA_KEY_PREFIX}x`]: "corrupted" })).toEqual([]);
  });

  test("returns nothing for a site with no ideas", () => {
    expect(scanIdeas({})).toEqual([]);
  });
});

describe("newIdeaKey", () => {
  test("is prefixed and unique", () => {
    const a = newIdeaKey();
    expect(a.startsWith(IDEA_KEY_PREFIX)).toBe(true);
    expect(a).not.toBe(newIdeaKey());
  });
});

describe("dedupeSuggestedThemes", () => {
  test("drops what already exists, ignoring case, accents and spacing", () => {
    const fresh = dedupeSuggestedThemes(
      ["Como ler a etiqueta de composição"],
      [
        { title: "  como LER a etiqueta de COMPOSICAO  " },
        { title: "Por que o linho amassa" },
      ],
    );
    expect(fresh.map((t) => t.title)).toEqual(["Por que o linho amassa"]);
  });

  test("drops duplicates within the same batch", () => {
    const fresh = dedupeSuggestedThemes(
      [],
      [{ title: "Tecidos naturais" }, { title: "tecidos naturais" }],
    );
    expect(fresh).toHaveLength(1);
  });

  test("drops a blank title — it can't be told apart from another blank", () => {
    expect(dedupeSuggestedThemes([], [{ title: "   " }])).toEqual([]);
  });

  test("keeps everything when nothing exists yet", () => {
    const suggested = [{ title: "Um" }, { title: "Dois" }];
    expect(dedupeSuggestedThemes([], suggested)).toEqual(suggested);
  });

  test("carries the whole suggestion through, not just the title", () => {
    expect(
      dedupeSuggestedThemes([], [{ title: "Um", body: "briefing" }]),
    ).toEqual([{ title: "Um", body: "briefing" }]);
  });
});

describe("postStructures", () => {
  test("reads each post's section sequence as component names, in order", () => {
    const decofile = decofileWithPosts({
      "collections/blog/posts/a": {
        title: "Guia",
        sections: [
          { __resolveType: "blog/sections/blocks/Heading.tsx" },
          { __resolveType: "site/sections/Blog/Post/Paragraph.tsx" },
          { __resolveType: "blog/sections/blocks/ProductShelf.tsx" },
        ],
      },
    });
    expect(postStructures(decofile)).toEqual([
      {
        key: "collections/blog/posts/a",
        title: "Guia",
        sections: ["Heading", "Paragraph", "ProductShelf"],
      },
    ]);
  });

  test("a post with no sections still reports its title", () => {
    const decofile = decofileWithPosts({
      "collections/blog/posts/empty": { title: "Vazio" },
    });
    expect(postStructures(decofile)[0]?.sections).toEqual([]);
  });

  test("skips sections without a resolveType instead of emitting blanks", () => {
    const decofile = decofileWithPosts({
      "collections/blog/posts/a": {
        sections: [
          { __resolveType: "blog/sections/blocks/Heading.tsx" },
          { text: "orphan" },
          "not an object",
        ],
      },
    });
    expect(postStructures(decofile)[0]?.sections).toEqual(["Heading"]);
  });

  test("caps at 40 posts so the suggestion prompt stays bounded", () => {
    const posts: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 60; i++) {
      posts[`collections/blog/posts/p${i}`] = { title: `Post ${i}` };
    }
    expect(postStructures(decofileWithPosts(posts))).toHaveLength(40);
  });
});

describe("citedSections", () => {
  test("collects distinct @mentions", () => {
    expect(
      citedSections("Abre com @Heading, depois @Paragraph e mais @Paragraph."),
    ).toEqual(["Heading", "Paragraph"]);
  });

  test("ignores an @ inside a word, so an email is not a citation", () => {
    expect(citedSections("fale com contato@marca.com.br")).toEqual([]);
  });

  test("reads a citation after a bracket or at the start of a line", () => {
    expect(citedSections("@Heading\n- (@Cta) no fim")).toEqual([
      "Heading",
      "Cta",
    ]);
  });

  test("stops at punctuation but keeps dashes inside the name", () => {
    expect(citedSections("use @Product-Card.")).toEqual(["Product-Card"]);
  });

  test("finds nothing in prose without mentions", () => {
    expect(citedSections("Um formato de guia prático.")).toEqual([]);
  });
});

describe("unknownCitations", () => {
  test("reports only the citations the site does not have", () => {
    expect(
      unknownCitations("@Heading e @Removida", ["Heading", "Paragraph"]),
    ).toEqual(["Removida"]);
  });

  test("nothing to report when every citation resolves", () => {
    expect(unknownCitations("@Heading", ["Heading"])).toEqual([]);
  });

  test("every citation is unknown on a site with no blog sections", () => {
    expect(unknownCitations("@Heading e @Cta", [])).toEqual(["Heading", "Cta"]);
  });
});

describe("defaultFormatSections", () => {
  test("keeps the preferred order and drops what the site lacks", () => {
    expect(
      defaultFormatSections(["Cta", "Paragraph", "Heading", "Shelf"]),
    ).toEqual(["Heading", "Paragraph", "Cta"]);
  });

  test("returns nothing when the site has none of them", () => {
    expect(defaultFormatSections(["Shelf"])).toEqual([]);
  });
});

describe("filledBrandRules", () => {
  test("drops the blank row the editor keeps, so a prompt never sees it", () => {
    expect(
      filledBrandRules([
        { name: "Preços", value: "Use ProductCard." },
        { name: "", value: "" },
      ]),
    ).toEqual([{ name: "Preços", value: "Use ProductCard." }]);
  });

  test("whitespace is not substance", () => {
    expect(filledBrandRules([{ name: "  ", value: "\n" }])).toEqual([]);
  });

  test("a name alone or a body alone counts as written", () => {
    const rules = [
      { name: "só nome", value: "" },
      { name: "", value: "só corpo" },
    ];
    expect(filledBrandRules(rules)).toEqual(rules);
  });
});

describe("missingBrandForGeneration", () => {
  const complete = {
    companyName: "Marca",
    language: "pt-BR",
    description: "Vende roupa",
    tone: "Segunda pessoa, sem humor",
    targetAudience: "Quem procura linho",
    dos: [{ name: "Abertura", value: "Comece pelo leitor" }],
    avoid: [{ name: "Preço", value: "Nunca em bloco de texto" }],
  };

  test("nothing missing when the three required tabs are filled", () => {
    expect(missingBrandForGeneration(complete)).toEqual([]);
  });

  test("an absent block is missing everything", () => {
    expect(missingBrandForGeneration(undefined)).toEqual([
      "companyName",
      "language",
      "description",
      "tone",
      "targetAudience",
      "dos",
      "avoid",
    ]);
  });

  test("whitespace does not satisfy a text field", () => {
    expect(missingBrandForGeneration({ ...complete, tone: "   " })).toEqual([
      "tone",
    ]);
  });

  test("a rule list holding only the blank editor row counts as missing", () => {
    expect(
      missingBrandForGeneration({
        ...complete,
        dos: [{ name: "", value: "" }],
      }),
    ).toEqual(["dos"]);
  });

  test("values, categories and competitors are not required", () => {
    expect(
      missingBrandForGeneration({
        ...complete,
        values: [],
        categories: [],
        competitors: [],
      }),
    ).toEqual([]);
  });
});

describe("sectionResolveTypes", () => {
  test("maps a component name to this site's own resolveType", () => {
    expect(
      sectionResolveTypes(metaWith(["site/sections/Blog/Post/Heading.tsx"])),
    ).toEqual({ Heading: "site/sections/Blog/Post/Heading.tsx" });
  });

  test("one name wins when app and site both define it", () => {
    const map = sectionResolveTypes(
      metaWith([
        "blog/sections/blocks/Paragraph.tsx",
        "site/sections/Blog/Post/Paragraph.tsx",
      ]),
    );
    expect(Object.keys(map)).toEqual(["Paragraph"]);
  });

  test("a site with no post sections maps nothing", () => {
    expect(sectionResolveTypes(metaWith(["site/sections/Header.tsx"]))).toEqual(
      {},
    );
  });
});

describe("buildPostSections", () => {
  const types = {
    Heading: "blog/sections/blocks/Heading.tsx",
    Paragraph: "blog/sections/blocks/Paragraph.tsx",
    List: "blog/sections/blocks/List.tsx",
    Quote: "blog/sections/blocks/Quote.tsx",
    Callout: "blog/sections/blocks/Callout.tsx",
    Cta: "blog/sections/blocks/Cta.tsx",
    Divider: "blog/sections/blocks/Divider.tsx",
  };

  test("a List stores its items newline-joined, not as an array", () => {
    expect(
      buildPostSections(
        [{ type: "List", items: ["um", "dois"], style: "ordered" }],
        types,
      ),
    ).toEqual([
      { __resolveType: types.List, items: "um\ndois", style: "ordered" },
    ]);
  });

  test("fills each kind's own props", () => {
    expect(
      buildPostSections(
        [
          { type: "Heading", text: "Título", level: "3" },
          { type: "Paragraph", html: "<strong>oi</strong>" },
          { type: "Quote", quote: "citação" },
          { type: "Callout", title: "Dica", body: "corpo", variant: "tip" },
          { type: "Cta", text: "Ver", href: "/colecao" },
          { type: "Divider" },
        ],
        types,
      ),
    ).toEqual([
      { __resolveType: types.Heading, text: "Título", level: "3" },
      { __resolveType: types.Paragraph, html: "<strong>oi</strong>" },
      { __resolveType: types.Quote, quote: "citação" },
      {
        __resolveType: types.Callout,
        title: "Dica",
        body: "corpo",
        variant: "tip",
      },
      { __resolveType: types.Cta, text: "Ver", href: "/colecao" },
      { __resolveType: types.Divider },
    ]);
  });

  test("defaults the enums rather than writing undefined", () => {
    expect(buildPostSections([{ type: "Heading", text: "T" }], types)).toEqual([
      { __resolveType: types.Heading, text: "T", level: "2" },
    ]);
    expect(buildPostSections([{ type: "List", items: ["a"] }], types)).toEqual([
      { __resolveType: types.List, items: "a", style: "unordered" },
    ]);
  });

  test("drops a kind this site cannot render", () => {
    expect(
      buildPostSections(
        [
          { type: "Heading", text: "fica" },
          { type: "Callout", title: "sai", body: "sai" },
        ],
        { Heading: types.Heading },
      ),
    ).toEqual([{ __resolveType: types.Heading, text: "fica", level: "2" }]);
  });

  test("keeps the reading order", () => {
    const built = buildPostSections(
      [
        { type: "Heading", text: "a" },
        { type: "Paragraph", html: "b" },
        { type: "Heading", text: "c" },
      ],
      types,
    );
    expect(built.map((b) => b.__resolveType)).toEqual([
      types.Heading,
      types.Paragraph,
      types.Heading,
    ]);
  });
});

describe("slugifyTitle", () => {
  test("folds accents and drops punctuation", () => {
    expect(slugifyTitle("Como ler a etiqueta de composição!")).toBe(
      "como-ler-a-etiqueta-de-composicao",
    );
  });

  test("collapses runs and trims the edges", () => {
    expect(slugifyTitle("  --  Linho   &   Algodão -- ")).toBe("linho-algodao");
  });

  test("a title with nothing slug-worthy yields empty", () => {
    expect(slugifyTitle("!!! ???")).toBe("");
  });
});

describe("uniquePostSlug", () => {
  test("uses the plain slug when it's free", () => {
    expect(uniquePostSlug("Linho no verão", [])).toBe("linho-no-verao");
  });

  test("suffixes past a collision", () => {
    expect(uniquePostSlug("Linho", ["linho"])).toBe("linho-2");
    expect(uniquePostSlug("Linho", ["linho", "linho-2"])).toBe("linho-3");
  });

  test("falls back to a random slug for an unslugifiable title", () => {
    expect(uniquePostSlug("!!!", [])).toMatch(/^post-[0-9a-f]{6}$/);
  });
});

describe("buildGeneratedPostPayload", () => {
  const args = {
    draft: {
      title: "Por que o linho amassa",
      excerpt: "E o que isso diz sobre a peça.",
      seo: { title: "Por que o linho amassa", description: "Entenda a fibra." },
      categorySlugs: ["tecidos"],
      authorEmails: ["ana@marca.com"],
      sections: [{ type: "Paragraph" as const, html: "corpo" }],
    },
    resolveTypes: { Paragraph: "blog/sections/blocks/Paragraph.tsx" },
    categories: [
      { name: "Tecidos", slug: "tecidos" },
      { name: "Outra", slug: "outra" },
    ],
    authors: [
      { name: "Ana", email: "ana@marca.com" },
      { name: "Bruno", email: "bruno@marca.com" },
    ],
    takenSlugs: [],
    now: new Date("2026-08-21T12:00:00.000Z"),
  };

  test("lands in review, never scheduled or published", () => {
    const payload = buildGeneratedPostPayload(args);
    expect(payload.status).toBe("awaiting_review");
    expect(payload.scheduledDatetime).toBe("");
  });

  test("the editorial date is the day it was generated", () => {
    expect(buildGeneratedPostPayload(args).date).toBe("2026-08-21");
  });

  test("resolves only the chosen categories into stored refs", () => {
    expect(buildGeneratedPostPayload(args).categories).toEqual([
      { name: "Tecidos", slug: "tecidos" },
    ]);
  });

  test("resolves only the chosen authors into stored refs", () => {
    expect(buildGeneratedPostPayload(args).authors).toEqual([
      { name: "Ana", email: "ana@marca.com" },
    ]);
  });

  test("an unmatched pick attributes nobody rather than inventing an author", () => {
    const payload = buildGeneratedPostPayload({
      ...args,
      draft: { ...args.draft, authorEmails: ["ghost@marca.com"] },
    });
    expect(payload.authors).toEqual([]);
  });

  test("keeps the briefing, so the card still shows its pillar and format", () => {
    const payload = buildGeneratedPostPayload({
      ...args,
      planning: { pillarTitle: "Casos de clientes", brief: "Angle." },
    });
    expect(planningMeta(payload).pillarTitle).toBe("Casos de clientes");
  });

  test("leaves the cover image empty, so the reviewer is told", () => {
    const payload = buildGeneratedPostPayload(args);
    expect(payload.image).toBe("");
    expect(missingPostFields(payload)).toEqual(["Cover image"]);
  });

  test("avoids a slug another post already holds", () => {
    expect(
      buildGeneratedPostPayload({
        ...args,
        takenSlugs: ["por-que-o-linho-amassa"],
      }).slug,
    ).toBe("por-que-o-linho-amassa-2");
  });
});

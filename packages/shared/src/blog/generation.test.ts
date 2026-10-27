import { describe, expect, test } from "bun:test";
import { blocksForFormat } from "./generation";
import type { LiveMeta } from "./live-meta";
import { postLinkTargets } from "./post-meta";

/**
 * The narrowing a format does, and the list of posts a new one must not
 * collide with.
 *
 * `blocksForFormat` is what `BLOG_SITE_BLOCKS` returns, so it is the whole
 * contract between what a site renders and what a model is allowed to write.
 * It was the one piece of the chain with no test of its own, which was
 * survivable while a person in a browser was the only caller.
 */

function metaWith(
  resolveTypes: string[],
  schemas: Record<string, Record<string, unknown>> = {},
): LiveMeta {
  const sections: Record<string, { $ref?: string }> = {};
  const definitions: Record<string, Record<string, unknown>> = {};
  for (const resolveType of resolveTypes) {
    const schema = schemas[resolveType];
    if (!schema) {
      sections[resolveType] = {};
      continue;
    }
    const key = `Def${Object.keys(definitions).length}`;
    definitions[key] = schema;
    sections[resolveType] = { $ref: `#/definitions/${key}` };
  }
  return {
    manifest: { blocks: { sections } },
    schema: { definitions },
  };
}

const SITE = [
  "site/sections/Blog/Post/Heading.tsx",
  "site/sections/Blog/Post/Paragraph.tsx",
  "site/sections/Blog/Post/ProductShelf.tsx",
];

describe("blocksForFormat", () => {
  test("a format's @citations pick which blocks a writer may reach for", () => {
    const blocks = blocksForFormat(
      { value: "Open with @Heading, then @Paragraph." },
      metaWith(SITE),
      {},
    );
    expect(blocks.map((block) => block.name).sort()).toEqual([
      "Heading",
      "Paragraph",
    ]);
  });

  test("a format citing nothing gets everything, rather than nothing", () => {
    const blocks = blocksForFormat(
      { value: "Just write it." },
      metaWith(SITE),
      {},
    );
    expect(blocks.map((block) => block.name).sort()).toEqual([
      "Heading",
      "Paragraph",
      "ProductShelf",
    ]);
  });

  test("a citation this site does not render is dropped, not invented", () => {
    const blocks = blocksForFormat(
      { value: "Use @Heading and @Carousel." },
      metaWith(SITE),
      {},
    );
    expect(blocks.map((block) => block.name)).toEqual(["Heading"]);
  });

  test("a site with no post sections offers none", () => {
    expect(
      blocksForFormat(
        { value: "@Heading" },
        metaWith(["site/sections/Header.tsx"]),
        {},
      ),
    ).toEqual([]);
  });

  test("every block carries the schema its props must match", () => {
    const [block] = blocksForFormat(
      { value: "@Heading" },
      metaWith(["site/sections/Blog/Post/Heading.tsx"], {
        "site/sections/Blog/Post/Heading.tsx": {
          title: "Heading",
          description: "A section title",
          type: "object",
          properties: { text: { type: "string" } },
        },
      }),
      {},
    );
    expect(block?.name).toBe("Heading");
    expect(block?.schema).toHaveProperty("properties");
  });

  test("an example comes from a post this site already renders", () => {
    const decofile = {
      "collections/blog/posts/a": {
        __resolveType: "blog/loaders/Blogpost.ts",
        post: {
          sections: [
            {
              __resolveType: "site/sections/Blog/Post/Heading.tsx",
              text: "How we pack",
            },
          ],
        },
      },
    };
    const [block] = blocksForFormat(
      { value: "@Heading" },
      metaWith(["site/sections/Blog/Post/Heading.tsx"]),
      decofile,
    );
    expect(block?.example).toMatchObject({ text: "How we pack" });
  });
});

describe("postLinkTargets", () => {
  const decofile = {
    "collections/blog/posts/a": {
      __resolveType: "blog/loaders/Blogpost.ts",
      post: { title: "How we pack", slug: "how-we-pack" },
    },
    "collections/blog/posts/b": {
      __resolveType: "blog/loaders/Blogpost.ts",
      post: { title: "Unslugged", slug: "" },
    },
    "collections/blog/authors/c": {
      __resolveType: "blog/loaders/Author.ts",
      author: { name: "Someone", email: "someone@example.com" },
    },
  };

  test("reads live posts and leaves the other collections alone", () => {
    expect(postLinkTargets(decofile)).toEqual([
      { title: "How we pack", slug: "how-we-pack" },
    ]);
  });

  test("a post with no slug is not a link target and not a taken slug", () => {
    expect(postLinkTargets(decofile).map((post) => post.slug)).not.toContain(
      "",
    );
  });

  test("an empty decofile has no targets rather than throwing", () => {
    expect(postLinkTargets({})).toEqual([]);
  });
});

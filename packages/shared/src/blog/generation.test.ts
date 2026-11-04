import { describe, expect, test } from "bun:test";
import {
  blocksForFormat,
  buildPostSections,
  productShape,
  referencePosts,
} from "./generation";
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
  test("a format's @citations pick the blocks, and a product block the site never filled stays out", () => {
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

  test("citations in code backticks narrow the blocks too", () => {
    const blocks = blocksForFormat(
      { value: "- `@Heading`, `@Paragraph`: corpo e critérios." },
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
    expect(blocks.map((block) => block.name)).toEqual(["Heading", "Paragraph"]);
  });

  test("the basic text comes along whatever the format cites, after what it cites", () => {
    const names = blocksForFormat(
      { value: "Decide with @Steps, then a @Callout." },
      metaWith([
        ...SITE,
        "site/sections/Blog/Post/Steps.tsx",
        "site/sections/Blog/Post/Callout.tsx",
        "site/sections/Blog/Post/Quote.tsx",
      ]),
      {},
    ).map((block) => block.name);
    expect(names.slice(0, 2).sort()).toEqual(["Callout", "Steps"]);
    expect(names.slice(2)).toEqual(["Heading", "Paragraph"]);
  });

  test("a cited basic block appears once, where the citation put it", () => {
    const names = blocksForFormat(
      { value: "Mostly @Paragraph." },
      metaWith(SITE),
      {},
    ).map((block) => block.name);
    expect(names).toEqual(["Paragraph", "Heading"]);
  });

  test("a product block the site already fills comes along, whatever its name", () => {
    const decofile = {
      "collections/blog/posts/a": {
        __resolveType: "blog/loaders/Blogpost.ts",
        post: {
          sections: [
            {
              __resolveType: "site/sections/Blog/Post/Vitrine.tsx",
              products: ["123"],
            },
          ],
        },
      },
    };
    const names = blocksForFormat(
      { value: "Open with @Heading." },
      metaWith([...SITE, "site/sections/Blog/Post/Vitrine.tsx"]),
      decofile,
    ).map((block) => block.name);
    expect(names).toContain("Vitrine");
    expect(names).not.toContain("ProductShelf");
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

describe("a product block's example", () => {
  const SHELF = "site/sections/Blog/Post/ProductShelf.tsx";
  test("is the shelf its slot is copied from, so its schema still compiles", () => {
    const post = (date: string, products: unknown) => ({
      __resolveType: "blog/loaders/Blogpost.ts",
      post: {
        title: date,
        date,
        sections: [{ __resolveType: SHELF, title: "Malas", products }],
      },
    });
    const [block] = blocksForFormat(
      { value: "@ProductShelf" },
      metaWith([SHELF], {
        [SHELF]: {
          type: "object",
          properties: {
            title: { type: "string" },
            products: {
              type: "array",
              items: { type: "string" },
              nullable: true,
            },
          },
        },
      }),
      {
        "collections/blog/posts/a": post("2026-01-10", ["vtex:product:1"]),
        "collections/blog/posts/b": post("2026-10-30", {
          __resolveType: "vtex/loaders/intelligentSearch/productList.ts",
          props: { ids: ["2"] },
        }),
      },
    );
    expect(block?.example).toMatchObject({ products: ["vtex:product:1"] });
    expect(block?.schema).toMatchObject({
      properties: { products: { type: "array", nullable: true } },
    });
  });
});

describe("productShape", () => {
  const SHELF = "site/sections/Blog/Post/ProductShelf.tsx";
  const shelf = (date: string, products: string[]) => ({
    __resolveType: "blog/loaders/Blogpost.ts",
    post: {
      title: date,
      date,
      sections: [{ __resolveType: SHELF, title: "Malas", products }],
    },
  });

  test("copies a shelf that names its products by reference over a newer one with bare ids", () => {
    expect(
      productShape(SHELF, {
        "collections/blog/posts/a": shelf("2026-01-10", ["vtex:product:1"]),
        "collections/blog/posts/b": shelf("2026-10-30", ["1948858"]),
      }),
    ).toMatchObject({ products: ["vtex:product:1"] });
  });

  test("falls back to the newest shelf when none uses a reference", () => {
    expect(
      productShape(SHELF, {
        "collections/blog/posts/a": shelf("2026-01-10", ["1"]),
        "collections/blog/posts/b": shelf("2026-10-30", ["2"]),
      }),
    ).toMatchObject({ products: ["2"] });
  });
});

describe("a campaign's products in a site's stored shape", () => {
  const SHELF = "site/sections/Blog/Post/ProductShelf.tsx";
  const build = (stored: unknown, ids: string[]) =>
    buildPostSections(
      [{ type: "ProductShelf", props: { title: "Malas" }, productIds: ids }],
      { ProductShelf: SHELF },
      { ProductShelf: { products: stored } },
    )[0];

  test("take the admin's reference form the site stores", () => {
    expect(
      build(["vtex:product:1951568"], ["1948858", "1951101"]),
    ).toMatchObject({
      products: ["vtex:product:1948858", "vtex:product:1951101"],
    });
  });

  test("stay product references where the site stores SKU refs", () => {
    expect(build(["vtex:sku:151294"], ["1948858"])).toMatchObject({
      products: ["vtex:product:1948858"],
    });
  });

  test("stay bare where the site stores bare ids", () => {
    expect(build(["1951568"], ["1948858"])).toMatchObject({
      products: ["1948858"],
    });
  });
});

describe("referencePosts", () => {
  const post = (slug: string, planning?: Record<string, unknown>) => ({
    __resolveType: "blog/loaders/Blogpost.ts",
    post: {
      title: slug,
      slug,
      date: "2026-10-01",
      ...(planning ? { planning } : {}),
    },
  });

  test("a person's post counts even with a planning brief; a generated one never does", () => {
    expect(
      referencePosts({
        "collections/blog/posts/a": post("escrito", {}),
        "collections/blog/posts/b": post("com-brief", { brief: "Guia" }),
        "collections/blog/posts/c": post("gerado", { generated: true }),
      })
        .map((p) => p.slug)
        .sort(),
    ).toEqual(["com-brief", "escrito"]);
  });
});

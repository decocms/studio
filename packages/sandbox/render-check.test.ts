import { describe, expect, it } from "bun:test";

type Block = Record<string, unknown> & { kind: string; index: number };
type Expected = { title: string; cover: string | null; blocks: Block[] };
type Problem = { width: string; kind: string; section: number | null };

/** Extensionless CJS beside the skill that runs it, like the qa-screenshot bin; `require` reaches its pure helpers without playwright. */
const { expectedFromPost, headingLevel, parseArgs, problemsOf, sliceOffsets } =
  require("./image/skills/blogpost/render-check") as {
    expectedFromPost: (post: Record<string, unknown>) => Expected;
    headingLevel: (value: unknown) => number | null;
    parseArgs: (argv: string[]) => Record<string, unknown>;
    problemsOf: (width: string, findings: Record<string, unknown>) => Problem[];
    sliceOffsets: (height: number) => number[];
  };

const POST = "site/sections/Blog/Post";

describe("parseArgs", () => {
  it("takes the page, where to write, and the post to check against", () => {
    expect(
      parseArgs(["https://a.site/blog/x", "/tmp/out", "--post=/tmp/post.json"]),
    ).toEqual({
      url: "https://a.site/blog/x",
      outdir: "/tmp/out",
      post: "/tmp/post.json",
    });
  });

  it("asks for usage without a page or a place to write", () => {
    expect(parseArgs(["https://a.site"])).toHaveProperty("error");
  });
});

describe("headingLevel", () => {
  it("reads a level however it was written", () => {
    expect(headingLevel("h3")).toBe(3);
    expect(headingLevel("3")).toBe(3);
    expect(headingLevel(2)).toBe(2);
    expect(headingLevel("big")).toBeNull();
  });
});

describe("expectedFromPost", () => {
  it("reads a draft as the writer wrote it", () => {
    const { cover, blocks } = expectedFromPost({
      title: "Guia",
      cover: { url: "https://cdn/c.png" },
      sections: [
        { type: "Heading", props: { text: "Tamanhos", level: "3" } },
        { type: "ProductShelf", props: { title: "Malas" }, productIds: ["1"] },
        { type: "BlockImage", props: { url: "https://cdn/b.png", alt: "" } },
        {
          type: "Paragraph",
          props: { html: "<p>Até <b>10 kg</b> na cabine.</p>" },
        },
      ],
    });
    expect(cover).toBe("https://cdn/c.png");
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "products",
      "image",
      "text",
    ]);
    expect(blocks[0]).toMatchObject({ level: 3, written: "3" });
    expect(blocks[3]).toMatchObject({ sample: "Até 10 kg na cabine." });
  });

  it("reads an assembled post as the site stores it", () => {
    const { cover, blocks } = expectedFromPost({
      title: "Guia",
      image: "https://cdn/c.png",
      sections: [
        { __resolveType: `${POST}/Heading.tsx`, text: "FAQ", level: "h2" },
        {
          __resolveType: `${POST}/ProductShelf.tsx`,
          products: ["vtex:product:1"],
        },
      ],
    });
    expect(cover).toBe("https://cdn/c.png");
    expect(blocks).toMatchObject([
      { kind: "heading", name: "Heading", level: 2 },
      { kind: "products", name: "ProductShelf" },
    ]);
  });
});

describe("problemsOf", () => {
  const clean = { status: 200, title: true, cover: "loaded", overflow: false };

  it("finds nothing on a page that renders the post", () => {
    expect(
      problemsOf("desktop", {
        ...clean,
        blocks: [
          {
            index: 0,
            kind: "heading",
            text: "A",
            level: 2,
            written: "h2",
            found: true,
            tag: "h2",
          },
          {
            index: 1,
            kind: "text",
            name: "Paragraph",
            sample: "x",
            found: true,
          },
          {
            index: 2,
            kind: "heading",
            text: "B",
            level: 3,
            written: "h3",
            found: true,
            tag: "h3",
          },
          {
            index: 3,
            kind: "products",
            name: "ProductShelf",
            title: "",
            products: 4,
          },
        ],
      }),
    ).toEqual([]);
  });

  it("a level the site ignores is a subheading rendered as a section title", () => {
    const problems = problemsOf("desktop", {
      ...clean,
      blocks: [
        {
          index: 4,
          kind: "heading",
          text: "Perguntas",
          level: 2,
          written: "2",
          found: true,
          tag: "h2",
        },
        {
          index: 5,
          kind: "heading",
          text: "Qual o peso?",
          level: 3,
          written: "3",
          found: true,
          tag: "h2",
          fontSize: "48px",
        },
      ],
    });
    expect(problems.map((p) => [p.kind, p.section])).toEqual([
      ["stacked-headings", 4],
      ["heading-level", 5],
    ]);
  });

  it("a product block that shows nothing, a broken cover and a lost block are what a reader sees", () => {
    const problems = problemsOf("mobile", {
      ...clean,
      cover: "broken",
      overflow: true,
      blocks: [
        {
          index: 1,
          kind: "products",
          name: "ProductShelf",
          title: "Malas",
          products: 0,
        },
        {
          index: 2,
          kind: "text",
          name: "Callout",
          sample: "Dica",
          found: false,
        },
        { index: 3, kind: "image", name: "BlockImage", state: "missing" },
      ],
    });
    expect(problems.map((p) => p.kind)).toEqual([
      "cover",
      "empty-products",
      "missing-block",
      "image",
      "overflow",
    ]);
    expect(problems.every((p) => p.width === "mobile")).toBe(true);
  });

  it("an error page is reported before anything on it", () => {
    expect(
      problemsOf("desktop", { ...clean, status: 404, blocks: [] })[0],
    ).toMatchObject({
      kind: "status",
    });
  });
});

describe("sliceOffsets", () => {
  it("covers the page in slices, up to a cap", () => {
    expect(sliceOffsets(3500)).toEqual([0, 1600, 3200]);
    expect(sliceOffsets(100_000)).toHaveLength(10);
  });
});

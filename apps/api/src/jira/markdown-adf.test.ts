import { describe, expect, it } from "bun:test";
import { type AdfNode, markdownToAdf } from "./markdown-adf";

const doc = (markdown: string, header?: string) =>
  markdownToAdf(markdown, { header }).content;

describe("markdownToAdf inline marks", () => {
  it("renders the syntax a plain-text push leaked onto the issue", () => {
    expect(doc("**O que foi feito:** ajustei o `Footer.json`")).toEqual([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "O que foi feito:",
            marks: [{ type: "strong" }],
          },
          { type: "text", text: " ajustei o " },
          { type: "text", text: "Footer.json", marks: [{ type: "code" }] },
        ],
      },
    ]);
  });

  it("handles italics, strikethrough, and bold-italic together", () => {
    expect(doc("*a* _b_ ~~c~~ ***d***")).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "a", marks: [{ type: "em" }] },
          { type: "text", text: " " },
          { type: "text", text: "b", marks: [{ type: "em" }] },
          { type: "text", text: " " },
          { type: "text", text: "c", marks: [{ type: "strike" }] },
          { type: "text", text: " " },
          {
            type: "text",
            text: "d",
            marks: [{ type: "strong" }, { type: "em" }],
          },
        ],
      },
    ]);
  });

  it("leaves an unmatched or intraword delimiter as the character it is", () => {
    expect(doc("2 * 3 * 4 and snake_case_name and 100% *")).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "2 * 3 * 4 and snake_case_name and 100% *" },
        ],
      },
    ]);
  });

  it("keeps an escaped delimiter literal", () => {
    expect(doc("literal \\*stars\\* here")).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "literal *stars* here" }],
      },
    ]);
  });

  it("marks a nested emphasis inside bold", () => {
    expect(doc("**bold with *inner* end**")).toEqual([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "bold with ",
            marks: [{ type: "strong" }],
          },
          {
            type: "text",
            text: "inner",
            marks: [{ type: "strong" }, { type: "em" }],
          },
          { type: "text", text: " end", marks: [{ type: "strong" }] },
        ],
      },
    ]);
  });

  it("drops formatting marks inside a code span but keeps a wrapping link", () => {
    const [paragraph] = doc("[**`a*b`**](https://x.dev)");
    expect(paragraph?.content).toEqual([
      {
        type: "text",
        text: "a*b",
        marks: [
          { type: "link", attrs: { href: "https://x.dev" } },
          { type: "code" },
        ],
      },
    ]);
  });
});

describe("markdownToAdf links", () => {
  it("links a markdown link, an autolink, and a bare URL", () => {
    const hrefs = (markdown: string) =>
      doc(markdown)[0]?.content?.map((node) => [node.text, node.marks]);
    expect(hrefs("[PR](https://github.com/acme/site/pull/1)")).toEqual([
      [
        "PR",
        [
          {
            type: "link",
            attrs: { href: "https://github.com/acme/site/pull/1" },
          },
        ],
      ],
    ]);
    expect(hrefs("PR: https://github.com/acme/site/pull/1.")).toEqual([
      ["PR: ", undefined],
      [
        "https://github.com/acme/site/pull/1",
        [
          {
            type: "link",
            attrs: { href: "https://github.com/acme/site/pull/1" },
          },
        ],
      ],
      [".", undefined],
    ]);
    expect(hrefs("<https://envs.example.dev>")).toEqual([
      [
        "https://envs.example.dev",
        [{ type: "link", attrs: { href: "https://envs.example.dev" } }],
      ],
    ]);
  });

  it("never nests a link mark inside a link label", () => {
    const [paragraph] = doc("[see https://a.dev now](https://b.dev)");
    expect(paragraph?.content).toEqual([
      {
        type: "text",
        text: "see https://a.dev now",
        marks: [{ type: "link", attrs: { href: "https://b.dev" } }],
      },
    ]);
  });

  it("keeps a label as plain text when the target is not a usable URL", () => {
    // ADF rejects a link mark whose href a Jira reader could not follow.
    expect(
      doc("[click](javascript:alert(1)) [shot](/api/org/fs/read)"),
    ).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "click shot" }],
      },
    ]);
  });

  it("degrades an image to a link, and a Studio-relative one to its alt", () => {
    expect(doc("![diff](https://img.example.dev/a.png)")).toEqual([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "diff",
            marks: [
              {
                type: "link",
                attrs: { href: "https://img.example.dev/a.png" },
              },
            ],
          },
        ],
      },
    ]);
    expect(
      doc("![home page](/api/acme/fs/outputs/read?path=t%2Fa.png)"),
    ).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "home page" }] },
    ]);
  });
});

describe("markdownToAdf blocks", () => {
  it("splits paragraphs on blank lines and joins soft-wrapped lines", () => {
    expect(doc("one\ntwo\n\nthree")).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "one two" }] },
      { type: "paragraph", content: [{ type: "text", text: "three" }] },
    ]);
  });

  it("keeps an explicit hard break", () => {
    expect(doc("one  \ntwo")).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "one" },
          { type: "hardBreak" },
          { type: "text", text: "two" },
        ],
      },
    ]);
  });

  it("renders headings and a rule", () => {
    expect(doc("## Decisões\n\n---\n\n#nothashtag")).toEqual([
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Decisões" }],
      },
      { type: "rule" },
      { type: "paragraph", content: [{ type: "text", text: "#nothashtag" }] },
    ]);
  });

  it("renders a fenced code block with its language", () => {
    expect(doc("```ts {twoslash}\nconst a = 1;\n```")).toEqual([
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [{ type: "text", text: "const a = 1;" }],
      },
    ]);
  });

  it("closes a fence truncated by the push limit at end of input", () => {
    expect(doc("```\nhalf a diff")).toEqual([
      { type: "codeBlock", content: [{ type: "text", text: "half a diff" }] },
    ]);
  });

  it("renders a bullet list with a nested list and per-item marks", () => {
    expect(doc("- top **bold**\n  - nested\n- sibling")).toEqual([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "top " },
                  { type: "text", text: "bold", marks: [{ type: "strong" }] },
                ],
              },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "nested" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "sibling" }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("starts a new list when the marker switches between bullets and numbers", () => {
    expect(doc("- a\n1. b").map((node) => node.type)).toEqual([
      "bulletList",
      "orderedList",
    ]);
  });

  it("carries an ordered list's start number, and only when it is not 1", () => {
    expect(doc("3. c\n4. d")[0]?.attrs).toEqual({ order: 3 });
    expect(doc("1. c")[0]?.attrs).toBeUndefined();
  });

  it("keeps a fenced block that belongs to a list item inside it", () => {
    const [list] = doc("- run it:\n\n  ```sh\n  bun test\n  ```\n- then ship");
    expect(list?.content?.[0]?.content?.map((node) => node.type)).toEqual([
      "paragraph",
      "codeBlock",
    ]);
    expect(list?.content).toHaveLength(2);
  });

  it("renders a blockquote's own blocks", () => {
    expect(doc("> quoted **line**\n> - item")).toEqual([
      {
        type: "blockquote",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "quoted " },
              { type: "text", text: "line", marks: [{ type: "strong" }] },
            ],
          },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "item" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("renders a GFM table, padding a short row to the header width", () => {
    expect(doc("| a | b |\n| --- | :-: |\n| 1 |")).toEqual([
      {
        type: "table",
        attrs: { isNumberColumnEnabled: false, layout: "default" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: {},
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "a" }] },
                ],
              },
              {
                type: "tableHeader",
                attrs: {},
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "b" }] },
                ],
              },
            ],
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {},
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "1" }] },
                ],
              },
              {
                type: "tableCell",
                attrs: {},
                content: [{ type: "paragraph", content: [] }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("leaves a pipe row that has no delimiter row as prose", () => {
    expect(doc("| a | b |\nnot a table").map((node) => node.type)).toEqual([
      "paragraph",
    ]);
  });
});

describe("markdownToAdf structural guarantees", () => {
  it("prepends the header verbatim, never as markup", () => {
    expect(doc("**body**", "Ana *Nick* Souza · via Studio:")).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "Ana *Nick* Souza · via Studio:" }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "body", marks: [{ type: "strong" }] }],
      },
    ]);
  });

  it("emits a single empty paragraph for a body with no content", () => {
    expect(markdownToAdf("   \n\n  ")).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [] }],
    });
  });

  it("re-homes nodes ADF forbids in a listItem or a blockquote", () => {
    const [list] = doc("- ## heading in an item\n\n  > quoted\n\n  ---");
    expect(list?.content?.[0]?.content).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "heading in an item" }],
      },
      { type: "paragraph", content: [{ type: "text", text: "quoted" }] },
    ]);

    const [quote] = doc("> > deep\n> \n> | a |\n> | - |\n> | 1 |");
    expect(quote?.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "deep" }] },
      { type: "paragraph", content: [{ type: "text", text: "a 1" }] },
    ]);
  });

  it("holds the invariants Jira validates the document against", () => {
    const kitchenSink = [
      '**Verificado no preview** (https://envs.example.dev): renderiza `<a href="/x">X</a>`.',
      "",
      "# Título",
      "",
      "- item com `código` e [link](https://x.dev)",
      "  1. aninhado",
      "     ```json",
      '     { "a": 1 }',
      "     ```",
      "  2. ## heading proibido",
      "- ",
      "",
      "> ### citação",
      "> > mais fundo",
      "",
      "| a |",
      "| - |",
      "|   |",
      "",
      "``",
      "",
      "***",
      "",
      "![](/api/org/fs/read?path=a.png)",
    ].join("\n");

    const allowed: Record<string, ReadonlySet<string>> = {
      listItem: new Set([
        "paragraph",
        "bulletList",
        "orderedList",
        "codeBlock",
      ]),
      blockquote: new Set([
        "paragraph",
        "bulletList",
        "orderedList",
        "codeBlock",
      ]),
    };
    const walk = (node: AdfNode, parent: string) => {
      if (node.type === "text") {
        expect(typeof node.text).toBe("string");
        expect(node.text).not.toBe("");
      }
      const allowedHere = allowed[parent];
      if (allowedHere) expect(allowedHere.has(node.type)).toBe(true);
      if (node.type === "listItem") {
        expect(["paragraph", "codeBlock"]).toContain(
          node.content?.[0]?.type ?? "missing",
        );
      }
      if (node.type === "table") expect(parent).toBe("doc");
      for (const child of node.content ?? []) walk(child, node.type);
    };

    const document = markdownToAdf(kitchenSink, { header: "Super Agent:" });
    expect(document.content.length).toBeGreaterThan(0);
    walk(document as unknown as AdfNode, "root");
  });
});

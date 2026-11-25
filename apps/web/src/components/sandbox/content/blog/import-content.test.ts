import { describe, expect, test } from "bun:test";
import {
  buildImportedPostPayload,
  looksLikeHtml,
  parseImportedContent,
  sectionsToBlocks,
  type ImportedSection,
} from "./import-content";

describe("looksLikeHtml", () => {
  test("detects HTML by block tags or closing tags", () => {
    expect(looksLikeHtml("<h1>Hi</h1>")).toBe(true);
    expect(looksLikeHtml("<p>text</p>")).toBe(true);
    expect(looksLikeHtml("plain <img src='x'>")).toBe(true);
    expect(looksLikeHtml("# Markdown\n\ntext")).toBe(false);
    expect(looksLikeHtml("just some words")).toBe(false);
  });
});

describe("parseImportedContent — HTML", () => {
  test("takes the first H1 as the title and keeps the rest as body", () => {
    const { title, sections } = parseImportedContent(
      "<h1>Guia de malas</h1><p>Escolher a mala certa importa.</p><h2>Tamanhos</h2>",
    );
    expect(title).toBe("Guia de malas");
    expect(sections).toEqual([
      { kind: "paragraph", html: "Escolher a mala certa importa." },
      { kind: "heading", text: "Tamanhos", level: "2" },
    ]);
  });

  test("keeps inline markup in paragraphs but strips it from headings", () => {
    const { sections } = parseImportedContent(
      '<h2>Uma <em>seção</em></h2><p>Veja <a href="/couro">couro</a> e <strong>mais</strong>.</p>',
    );
    expect(sections[0]).toEqual({
      kind: "heading",
      text: "Uma seção",
      level: "2",
    });
    expect(sections[1]).toEqual({
      kind: "paragraph",
      html: 'Veja <a href="/couro">couro</a> e <strong>mais</strong>.',
    });
  });

  test("parses lists, quotes, dividers and images (incl. figures)", () => {
    const { sections } = parseImportedContent(
      "<ul><li>Um</li><li>Dois</li></ul>" +
        "<ol><li>Primeiro</li></ol>" +
        "<blockquote>Viaje leve</blockquote>" +
        "<hr/>" +
        '<img src="https://cdn/mala.jpg" alt="mala">' +
        '<figure><img src="https://cdn/f.jpg" alt="f"><figcaption>Legenda</figcaption></figure>',
    );
    expect(sections).toEqual([
      { kind: "list", items: ["Um", "Dois"], ordered: false },
      { kind: "list", items: ["Primeiro"], ordered: true },
      { kind: "quote", text: "Viaje leve" },
      { kind: "divider" },
      { kind: "image", url: "https://cdn/mala.jpg", alt: "mala", caption: "" },
      { kind: "image", url: "https://cdn/f.jpg", alt: "f", caption: "Legenda" },
    ]);
  });

  test("decodes entities and skips empty blocks", () => {
    const { sections } = parseImportedContent(
      "<p>Malas &amp; mochilas</p><p>   </p><p></p>",
    );
    expect(sections).toEqual([
      { kind: "paragraph", html: "Malas &amp; mochilas" },
    ]);
  });

  test("ignores script/style and a div wrapper around blocks", () => {
    const { title, sections } = parseImportedContent(
      "<style>.x{}</style><div><h1>T</h1><p>Corpo</p></div><script>bad()</script>",
    );
    expect(title).toBe("T");
    expect(sections).toEqual([{ kind: "paragraph", html: "Corpo" }]);
  });
});

describe("parseImportedContent — Markdown", () => {
  test("headings, paragraphs, lists, quote, divider and image", () => {
    const md = [
      "# Guia de malas",
      "",
      "Escolher a **mala** certa importa.",
      "",
      "## Tamanhos",
      "",
      "- Cabine",
      "- Despacho",
      "",
      "> Viaje leve",
      "",
      "---",
      "",
      "![capa](https://cdn/capa.jpg)",
    ].join("\n");
    const { title, sections } = parseImportedContent(md);
    expect(title).toBe("Guia de malas");
    expect(sections).toEqual([
      {
        kind: "paragraph",
        html: "Escolher a <strong>mala</strong> certa importa.",
      },
      { kind: "heading", text: "Tamanhos", level: "2" },
      { kind: "list", items: ["Cabine", "Despacho"], ordered: false },
      { kind: "quote", text: "Viaje leve" },
      { kind: "divider" },
      { kind: "image", url: "https://cdn/capa.jpg", alt: "capa", caption: "" },
    ]);
  });

  test("converts inline links and joins wrapped paragraph lines", () => {
    const { sections } = parseImportedContent("Veja [couro](/couro)\ne mais.");
    expect(sections).toEqual([
      { kind: "paragraph", html: 'Veja <a href="/couro">couro</a> e mais.' },
    ]);
  });

  test("numbered lists are ordered", () => {
    const { sections } = parseImportedContent("1. Um\n2. Dois");
    expect(sections).toEqual([
      { kind: "list", items: ["Um", "Dois"], ordered: true },
    ]);
  });
});

describe("parseImportedContent — untrusted markup", () => {
  const htmlOf = (input: string) =>
    parseImportedContent(input).sections.map((s) =>
      s.kind === "paragraph" ? s.html : s.kind,
    );

  test("an escaped tag stays escaped instead of being unescaped twice", () => {
    expect(
      htmlOf("<p>&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;</p>"),
    ).toEqual(["&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;"]);
  });

  test("a tag that only reassembles after an inner cut is still removed", () => {
    expect(htmlOf("<p>a</p><scr<x>ipt>alert(1)</script>")).toEqual(["a"]);
  });

  test("nested comments and nested script bodies are removed whole", () => {
    expect(htmlOf("<!--<!-- --><p>x</p>")).toEqual(["x"]);
    expect(
      htmlOf("<script><script>alert(1)</script></script><p>y</p>"),
    ).toEqual(["y"]);
  });

  test("cutting one kind of markup can complete the other, and both still go", () => {
    // Removing the script body is what turns `<!-` + `-- x -->` into a comment.
    expect(htmlOf("<!-<script>y</script>-- x --><p>ok</p>")).toEqual(["ok"]);
    expect(htmlOf("<scr<!--x-->ipt>alert(1)</script><p>ok</p>")).toEqual([
      "ok",
    ]);
  });

  test("a paragraph keeps inline formatting and loses everything else", () => {
    // The site renders this as HTML, so an event handler here is stored XSS.
    expect(htmlOf("<p>hi <img src=x onerror=alert(1)> there</p>")).toEqual([
      "hi  there",
    ]);
  });

  test("an unterminated tag becomes text, so it cannot borrow the page's next >", () => {
    // A replace only sees complete tags; this one has no `>` of its own and the
    // browser would close it with the next `>` in the document.
    expect(htmlOf('<p>hello <img src=x onerror="alert(1)" </p>')).toEqual([
      'hello &lt;img src=x onerror="alert(1)"',
    ]);
    expect(htmlOf('<p>x <a href="javascript:alert(1)" </p>')).toEqual([
      'x &lt;a href="javascript:alert(1)"',
    ]);
  });

  test("a bare < in prose is escaped rather than left to start a tag", () => {
    expect(htmlOf("<p>a < b</p>")).toEqual(["a &lt; b"]);
    expect(htmlOf('<p><<a>a href="javascript:alert(1)">x</p>')).toEqual([
      '&lt;<a>a href="javascript:alert(1)">x',
    ]);
  });

  test("a link to a script URL survives as a link with nowhere to go", () => {
    expect(htmlOf('<p><a href="javascript:alert(1)">click</a></p>')).toEqual([
      "<a>click</a>",
    ]);
    expect(htmlOf("Veja [click](javascript:alert(1))")).toEqual([
      "Veja <a>click</a>)",
    ]);
  });

  test("a scheme smuggled as a character reference cannot re-form", () => {
    // `&` is always re-escaped, so `java&#09;script:` stays inert text in the
    // href instead of decoding back into a tab and a live scheme.
    expect(htmlOf('<p><a href="java&#09;script:alert(1)">x</a></p>')).toEqual([
      '<a href="java&amp;#09;script:alert(1)">x</a>',
    ]);
    expect(htmlOf('<p><a href="java\nscript:alert(1)">x</a></p>')).toEqual([
      "<a>x</a>",
    ]);
  });

  test("an image whose src is a script URL is dropped, not imported", () => {
    expect(
      parseImportedContent('<img src="javascript:alert(1)">').sections,
    ).toEqual([]);
  });

  test("a Markdown image whose src is a script URL is dropped, not imported", () => {
    expect(parseImportedContent("![x](javascript:alert)").sections).toEqual([]);
  });

  test("ordinary links, emphasis and ampersands are untouched", () => {
    expect(
      htmlOf(
        '<p>Veja <a href="/couro">couro</a> e <strong>x</strong>. A &amp; B</p>',
      ),
    ).toEqual([
      'Veja <a href="/couro">couro</a> e <strong>x</strong>. A &amp; B',
    ]);
  });
});

describe("parseImportedContent — tables", () => {
  const table = (html: string) =>
    parseImportedContent(html).sections.filter((s) => s.kind === "table");

  test("a thead becomes the headers and the body rows keep their order", () => {
    const { sections } = parseImportedContent(
      "<p>Before</p><table><thead><tr><th>Model</th><th>BTUs</th></tr></thead>" +
        "<tbody><tr><td>A</td><td>9000</td></tr><tr><td>B</td><td>12000</td></tr></tbody></table><p>After</p>",
    );
    expect(sections).toEqual([
      { kind: "paragraph", html: "Before" },
      {
        kind: "table",
        headers: ["Model", "BTUs"],
        rows: [
          ["A", "9000"],
          ["B", "12000"],
        ],
      },
      { kind: "paragraph", html: "After" },
    ]);
  });

  test("without a thead, a first row of th cells is the header", () => {
    expect(
      table(
        "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
      ),
    ).toEqual([{ kind: "table", headers: ["A", "B"], rows: [["1", "2"]] }]);
  });

  test("a table with no header cells has no headers", () => {
    expect(
      table(
        "<table><tr><td>1</td><td>2</td></tr><tr><th>x</th><td>3</td></tr></table>",
      ),
    ).toEqual([
      {
        kind: "table",
        headers: [],
        rows: [
          ["1", "2"],
          ["x", "3"],
        ],
      },
    ]);
  });

  test("a cell's paragraphs and lists stay in the cell, not loose in the post", () => {
    const { sections } = parseImportedContent(
      "<table><tr><td><p>one</p><p>two</p></td><td><ul><li>a</li><li>b</li></ul></td></tr></table>",
    );
    expect(sections).toEqual([
      { kind: "table", headers: [], rows: [["one<br>two", "a<br>b"]] },
    ]);
  });

  test("a cell keeps inline formatting and loses everything else", () => {
    const [parsed] = table(
      '<table><tr><td><strong>b</strong> <a href="https://x.dev" onclick="x()">l</a></td>' +
        '<td><img src=x onerror="alert(1)">t<a href="javascript:alert(1)">j</a></td></tr></table>',
    );
    expect(parsed).toEqual({
      kind: "table",
      headers: [],
      rows: [['<strong>b</strong> <a href="https://x.dev">l</a>', "t<a>j</a>"]],
    });
  });

  test("a table wrapped in a figure is still a table", () => {
    expect(
      table(
        '<figure class="wp-block-table"><table><tr><td>1</td></tr></table><figcaption>c</figcaption></figure>',
      ),
    ).toEqual([{ kind: "table", headers: [], rows: [["1"]] }]);
  });

  test("a table with nothing in it is skipped, as are its empty rows", () => {
    expect(table("<table><tr><td> </td><td><br></td></tr></table>")).toEqual(
      [],
    );
    expect(
      table("<table><tr><td></td></tr><tr><td>1</td></tr></table>"),
    ).toEqual([{ kind: "table", headers: [], rows: [["1"]] }]);
  });

  test("a Markdown pipe table, with alignment and inline marks", () => {
    const { sections } = parseImportedContent(
      "intro\n\n| Model | BTUs |\n|:--|--:|\n| **A** | 9000 |\n| [B](https://x.dev) | a \\| b |\nafter",
    );
    expect(sections).toEqual([
      { kind: "paragraph", html: "intro" },
      {
        kind: "table",
        headers: ["Model", "BTUs"],
        rows: [
          ["<strong>A</strong>", "9000"],
          ['<a href="https://x.dev">B</a>', "a | b"],
        ],
      },
      { kind: "paragraph", html: "after" },
    ]);
  });

  test("a pipe in prose, with no delimiter row under it, stays a paragraph", () => {
    expect(parseImportedContent("a | b\nc | d").sections).toEqual([
      { kind: "paragraph", html: "a | b c | d" },
    ]);
  });
});

describe("sectionsToBlocks", () => {
  const resolveTypes = {
    Heading: "blog/sections/blocks/Heading.tsx",
    Paragraph: "blog/sections/blocks/Paragraph.tsx",
    List: "blog/sections/blocks/List.tsx",
    Quote: "blog/sections/blocks/Quote.tsx",
    Divider: "blog/sections/blocks/Divider.tsx",
    BlockImage: "blog/sections/blocks/BlockImage.tsx",
  };

  test("binds each kind to its block with the right prop shape", () => {
    const sections: ImportedSection[] = [
      { kind: "heading", text: "T", level: "2" },
      { kind: "paragraph", html: "<strong>b</strong>" },
      { kind: "list", items: ["a", "b"], ordered: true },
      { kind: "quote", text: "q" },
      { kind: "divider" },
      { kind: "image", url: "u", alt: "a", caption: "c" },
    ];
    expect(sectionsToBlocks(sections, resolveTypes)).toEqual([
      { __resolveType: resolveTypes.Heading, text: "T", level: "2" },
      { __resolveType: resolveTypes.Paragraph, html: "<strong>b</strong>" },
      { __resolveType: resolveTypes.List, items: "a\nb", style: "ordered" },
      { __resolveType: resolveTypes.Quote, quote: "q" },
      { __resolveType: resolveTypes.Divider },
      {
        __resolveType: resolveTypes.BlockImage,
        url: "u",
        alt: "a",
        caption: "c",
        size: "normal",
      },
    ]);
  });

  test("drops a kind the site does not expose", () => {
    const sections: ImportedSection[] = [
      { kind: "heading", text: "T", level: "1" },
      { kind: "image", url: "u", alt: "", caption: "" },
    ];
    expect(sectionsToBlocks(sections, { Heading: "rt/Heading" })).toEqual([
      { __resolveType: "rt/Heading", text: "T", level: "1" },
    ]);
  });

  test("a table is stored as JSON-encoded headers and rows", () => {
    const sections: ImportedSection[] = [
      { kind: "table", headers: ["A"], rows: [["1"], ["2"]] },
    ];
    expect(sectionsToBlocks(sections, { Table: "rt/Table" })).toEqual([
      { __resolveType: "rt/Table", headers: '["A"]', rows: '[["1"],["2"]]' },
    ]);
    expect(sectionsToBlocks(sections, resolveTypes)).toEqual([]);
  });
});

describe("buildImportedPostPayload", () => {
  const now = new Date(2026, 8, 1, 10);

  test("lands in review with a slug, date and body, no AI fields", () => {
    const payload = buildImportedPostPayload({
      title: "Guia de Malas",
      body: { sections: [{ __resolveType: "rt/Paragraph", html: "x" }] },
      takenSlugs: [],
      now,
    });
    expect(payload.status).toBe("in_review");
    expect(payload.slug).toBe("guia-de-malas");
    expect(payload.date).toBe("2026-09-01");
    expect(payload.image).toBe("");
    expect(payload.sections).toHaveLength(1);
    expect(payload).not.toHaveProperty("content");
  });

  test("carries an HTML body in content, with no sections", () => {
    const payload = buildImportedPostPayload({
      title: "Guia de Malas",
      body: { content: "<p>x</p>" },
      takenSlugs: [],
      now,
    });
    expect(payload.content).toBe("<p>x</p>");
    expect(payload).not.toHaveProperty("sections");
  });

  test("suffixes a slug that collides with an existing post", () => {
    const payload = buildImportedPostPayload({
      title: "Guia de Malas",
      body: { sections: [] },
      takenSlugs: ["guia-de-malas"],
      now,
    });
    expect(payload.slug).toBe("guia-de-malas-2");
  });
});

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

  test("a cell holding its own figure does not cut a figure-wrapped table short", () => {
    const { sections } = parseImportedContent(
      '<figure><table><tr><td><figure><img src="https://x.dev/a.png"></figure></td><td>Spec</td></tr>' +
        "<tr><td>A</td><td>B</td></tr></table></figure><p>After</p>",
    );
    expect(sections).toEqual([
      {
        kind: "table",
        headers: [],
        rows: [
          ["", "Spec"],
          ["A", "B"],
        ],
      },
      { kind: "paragraph", html: "After" },
    ]);
  });

  test("rows and cells whose end tags were left out are still read", () => {
    expect(
      table(
        "<table><thead><tr><th>M<th>B<tbody><tr><td>A<td>9000<tr><td>B<td>12000</table>",
      ),
    ).toEqual([
      {
        kind: "table",
        headers: ["M", "B"],
        rows: [
          ["A", "9000"],
          ["B", "12000"],
        ],
      },
    ]);
  });

  test("an empty thead leaves a first row of th cells as the header", () => {
    expect(
      table(
        "<table><thead></thead><tbody><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>",
      ),
    ).toEqual([{ kind: "table", headers: ["A", "B"], rows: [["1", "2"]] }]);
  });

  test("short rows are padded so no column shifts", () => {
    expect(
      table(
        "<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td></tr></table>",
      ),
    ).toEqual([
      { kind: "table", headers: ["A", "B", "C"], rows: [["1", "", ""]] },
    ]);
    expect(
      parseImportedContent("| A | B |\n|---|---|\n| 1 |\n| 2 | 3 | extra |")
        .sections,
    ).toEqual([
      {
        kind: "table",
        headers: ["A", "B"],
        rows: [
          ["1", ""],
          ["2", "3"],
        ],
      },
    ]);
  });

  test("a divider under a line with a pipe does not make it a table", () => {
    expect(parseImportedContent("| Note\n---\nnext").sections).toEqual([
      { kind: "paragraph", html: "| Note" },
      { kind: "divider" },
      { kind: "paragraph", html: "next" },
    ]);
  });

  test("a heading, list or quote right after a table is not one of its rows", () => {
    for (const [line, kind] of [
      ["## Pros | Cons", "heading"],
      ["- a | b", "list"],
      ["> a | b", "quote"],
    ] as const) {
      const { sections } = parseImportedContent(
        `| A | B |\n|---|---|\n| 1 | 2 |\n${line}`,
      );
      expect(sections.map((s) => s.kind)).toEqual(["table", kind]);
    }
  });

  test("a pipe table with inline HTML in a cell is still read as Markdown", () => {
    expect(
      parseImportedContent("| A | B |\n|---|---|\n| 1 | x<br>y |").sections,
    ).toEqual([
      { kind: "table", headers: ["A", "B"], rows: [["1", "x<br>y"]] },
    ]);
  });

  test("a pipe in prose, with no delimiter row under it, stays a paragraph", () => {
    expect(parseImportedContent("a | b\nc | d").sections).toEqual([
      { kind: "paragraph", html: "a | b c | d" },
    ]);
  });
});

describe("parseImportedContent — callouts", () => {
  const sectionsOf = (html: string) => parseImportedContent(html).sections;

  test("a bold line over the text is the title, and the class names the variant", () => {
    expect(
      sectionsOf(
        '<p>antes</p><div class="callout callout-warning"><strong>Atenção</strong><p>Prazo de 7 dias.</p></div><p>depois</p>',
      ),
    ).toEqual([
      { kind: "paragraph", html: "antes" },
      {
        kind: "callout",
        title: "Atenção",
        body: "Prazo de 7 dias.",
        variants: ["warning"],
      },
      { kind: "paragraph", html: "depois" },
    ]);
  });

  test("text loose in the div is kept, as a body with no title", () => {
    expect(
      sectionsOf(
        '<div class="callout">Dica: texto solto, sem parágrafo.</div>',
      ),
    ).toEqual([
      {
        kind: "callout",
        title: "",
        body: "Dica: texto solto, sem parágrafo.",
        variants: [],
      },
    ]);
  });

  test("a heading is the title, and the paragraphs under it share the body", () => {
    expect(
      sectionsOf(
        '<div class="callout tip"><h4>Dica</h4><p>Use com moderação.</p><p>Sempre.</p></div>',
      ),
    ).toEqual([
      {
        kind: "callout",
        title: "Dica",
        body: "Use com moderação.<br>Sempre.",
        variants: ["tip"],
      },
    ]);
  });

  test("divs nested for the title and the body do not end the callout early", () => {
    expect(
      sectionsOf(
        '<div class="callout callout--info mb-4"><div class="callout-title">Você sabia?</div><div class="callout-body"><p>Um.</p><ul><li>a</li><li>b</li></ul></div></div><p>fim</p>',
      ),
    ).toEqual([
      {
        kind: "callout",
        title: "Você sabia?",
        body: "Um.<br>a<br>b",
        variants: ["info", "mb-4"],
      },
      { kind: "paragraph", html: "fim" },
    ]);
  });

  test("a bold label ending in a colon is the title of its own line", () => {
    expect(
      sectionsOf(
        '<div class="callout"><p><strong>Dica:</strong> beba <em>água</em>.</p></div>',
      ),
    ).toEqual([
      {
        kind: "callout",
        title: "Dica",
        body: "beba <em>água</em>.",
        variants: [],
      },
    ]);
  });

  test("bold that only opens a sentence stays in the body", () => {
    expect(
      sectionsOf(
        '<div class="callout"><p><strong>Não</strong> lave à máquina.</p></div>',
      ),
    ).toEqual([
      {
        kind: "callout",
        title: "",
        body: "<strong>Não</strong> lave à máquina.",
        variants: [],
      },
    ]);
  });

  test("a callout of one line has no title, whatever marks that line", () => {
    expect(
      sectionsOf('<div class="callout"><h3>Só uma linha</h3></div>'),
    ).toEqual([
      { kind: "callout", title: "", body: "Só uma linha", variants: [] },
    ]);
    expect(
      sectionsOf('<div class="callout"><p><b>Em negrito.</b></p></div>'),
    ).toEqual([
      { kind: "callout", title: "", body: "<b>Em negrito.</b>", variants: [] },
    ]);
  });

  test("the body is sanitized like a paragraph, because the site renders it as HTML", () => {
    const [callout] = sectionsOf(
      '<div class="callout"><p>ok<img src=x onerror=alert(1)> &lt;script&gt;alert(1)&lt;/script&gt; <a href="javascript:alert(1)" onclick="x()">link</a></p></div>',
    );
    expect(callout).toEqual({
      kind: "callout",
      title: "",
      body: "ok &lt;script&gt;alert(1)&lt;/script&gt; <a>link</a>",
      variants: [],
    });
  });

  test("the class is matched whole and without regard to case", () => {
    expect(
      sectionsOf('<div class="Callout Callout_Product"><p>x</p></div>'),
    ).toEqual([
      { kind: "callout", title: "", body: "x", variants: ["product"] },
    ]);
    expect(
      sectionsOf(
        '<div class="callout-list"><p>a</p></div><div class="callouts"><p>b</p></div>',
      ),
    ).toEqual([
      { kind: "paragraph", html: "a" },
      { kind: "paragraph", html: "b" },
    ]);
  });

  test("a callout inside a wrapper div is found, and the wrapper stays transparent", () => {
    expect(
      sectionsOf(
        '<div class="post"><p>a</p><div class="callout product"><b>Produto</b><br>Leve já.</div><p>b</p></div>',
      ),
    ).toEqual([
      { kind: "paragraph", html: "a" },
      {
        kind: "callout",
        title: "Produto",
        body: "Leve já.",
        variants: ["product"],
      },
      { kind: "paragraph", html: "b" },
    ]);
  });

  test("an empty callout is skipped", () => {
    expect(
      sectionsOf('<div class="callout"> <p></p><br> </div><p>x</p>'),
    ).toEqual([{ kind: "paragraph", html: "x" }]);
  });

  test("a callout that never closes does not swallow the rest of the post", () => {
    expect(
      sectionsOf('<div class="callout"><p>a</p><h2>B</h2><p>c</p>'),
    ).toEqual([
      { kind: "paragraph", html: "a" },
      { kind: "heading", text: "B", level: "2" },
      { kind: "paragraph", html: "c" },
    ]);
  });

  test("a callout in a table cell stays in the cell", () => {
    expect(
      sectionsOf(
        '<table><tr><td><div class="callout"><p>nota</p></div></td></tr></table>',
      ),
    ).toEqual([{ kind: "table", headers: [], rows: [["nota"]] }]);
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

  describe("callouts", () => {
    const callout: ImportedSection = {
      kind: "callout",
      title: "Dica",
      body: "Leve <strong>menos</strong>.",
      variants: ["mb-4", "warning"],
    };
    const rt = { Callout: "rt/Callout" };
    const base = {
      __resolveType: "rt/Callout",
      title: "Dica",
      body: "Leve <strong>menos</strong>.",
    };

    test("takes the variant its classes name, among those the block declares", () => {
      expect(
        sectionsToBlocks([callout], rt, ["info", "tip", "warning", "product"]),
      ).toEqual([{ ...base, variant: "warning" }]);
    });

    test("writes the variant as the block spells it", () => {
      expect(sectionsToBlocks([callout], rt, ["Info", "Warning"])).toEqual([
        { ...base, variant: "Warning" },
      ]);
    });

    test("writes no variant the block does not declare", () => {
      expect(sectionsToBlocks([callout], rt, ["info", "success"])).toEqual([
        base,
      ]);
      expect(sectionsToBlocks([callout], rt)).toEqual([base]);
    });

    test("writes no variant when its classes name none", () => {
      expect(
        sectionsToBlocks([{ ...callout, variants: [] }], rt, ["info", "tip"]),
      ).toEqual([base]);
    });

    test("is dropped on a site with no Callout block", () => {
      expect(sectionsToBlocks([callout], resolveTypes, ["warning"])).toEqual(
        [],
      );
    });
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

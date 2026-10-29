import { describe, expect, test } from "bun:test";
import {
  brandDoDont,
  brandQuote,
  brandSections,
  fontName,
  groupBrandSections,
  pickBrandDir,
  withFontName,
  sectionMarkdown,
  writeFrontmatter,
  writeQuote,
  writeSection,
} from "./brand-md";

const BODY = `# Acme, brand guide

> Acme is the money app that talks like a smart friend,
> not a bank.

Intro paragraph.

## 1. Concept

Three feelings, always together:

## 2. Color (see \`tokens.css\`)

| Role | Token |
| --- | --- |

Rules:

## 4. Voice & tone

- **Person:** "you", always.

## 9. Do / Don't

- ✅ Lead with the **number**.
- ❌ Fake urgency.
`;

describe("brandSections", () => {
  test("one row per section, numbering and asides dropped", () => {
    expect(brandSections(BODY)).toEqual([
      { title: "Concept", summary: "Three feelings, always together:" },
      { title: "Color", summary: "Rules:" },
      { title: "Voice & tone", summary: 'Person: "you", always.' },
      { title: "Do / Don't", summary: "✅ Lead with the number." },
    ]);
  });

  test("no sections is no rows", () => {
    expect(brandSections("Just prose.")).toEqual([]);
  });
});

describe("brandQuote", () => {
  test("joins the first blockquote", () => {
    expect(brandQuote(BODY)).toBe(
      "Acme is the money app that talks like a smart friend, not a bank.",
    );
  });

  test("null without one", () => {
    expect(brandQuote("## Concept\n\nText.")).toBeNull();
  });
});

describe("brandDoDont", () => {
  test("first of each", () => {
    expect(brandDoDont(BODY)).toEqual({
      doLine: "Lead with the number.",
      dontLine: "Fake urgency.",
    });
  });

  test("null when absent", () => {
    expect(brandDoDont("Nothing here.")).toEqual({
      doLine: null,
      dontLine: null,
    });
  });
});

test("fontName takes the first family", () => {
  expect(fontName(`"Space Grotesk", system-ui, sans-serif`)).toBe(
    "Space Grotesk",
  );
});

describe("groupBrandSections", () => {
  const section = (title: string) => ({ title, summary: "" });
  const grouped = groupBrandSections(
    [
      "Voice & tone",
      "Audience",
      "Rules",
      "Do / Don't",
      "Policies",
      "Concept",
    ].map(section),
  );
  const itemOf = (id: string) =>
    grouped.groups.flatMap((g) => g.items).find((item) => item.id === id);

  test("each section under its part", () => {
    expect(itemOf("voice")?.sections.map((s) => s.title)).toEqual([
      "Voice & tone",
    ]);
    expect(itemOf("donts")?.sections.map((s) => s.title)).toEqual([
      "Do / Don't",
    ]);
    expect(itemOf("rules")?.sections.map((s) => s.title)).toEqual(["Rules"]);
    expect(itemOf("policies")?.sections.map((s) => s.title)).toEqual([
      "Policies",
    ]);
  });

  test("missing parts stay listed, the rest is more", () => {
    expect(itemOf("competitors")?.sections).toEqual([]);
    expect(grouped.more.map((s) => s.title)).toEqual(["Concept"]);
  });
});

describe("sections in place", () => {
  const md =
    "---\nname: Acme\n---\n\n## 1. Voice\n\nShort.\n\n## Rules\n\n- One.\n";

  test("reads a section by its display title", () => {
    expect(sectionMarkdown(md, "Voice")).toBe("Short.");
    expect(sectionMarkdown(md, "Values")).toBeNull();
  });

  test("replaces one section and keeps the rest", () => {
    expect(writeSection(md, "Voice", "Warm and short.")).toBe(
      "---\nname: Acme\n---\n\n## 1. Voice\n\nWarm and short.\n\n## Rules\n\n- One.\n",
    );
    expect(writeSection(md, "Rules", "- Two.")).toBe(
      "---\nname: Acme\n---\n\n## 1. Voice\n\nShort.\n\n## Rules\n\n- Two.\n",
    );
  });

  test("appends a missing one", () => {
    expect(writeSection(md, "Values", "Care.")).toBe(
      `${md}\n## Values\n\nCare.\n`,
    );
    expect(writeSection("", "Values", "Care.")).toBe("## Values\n\nCare.\n");
  });
});

describe("writeQuote", () => {
  test("replaces the first blockquote", () => {
    expect(
      writeQuote("# Acme\n\n> Old,\n> two lines.\n\nIntro.\n", "New."),
    ).toBe("# Acme\n\n> New.\n\nIntro.\n");
  });

  test("adds one before the first section", () => {
    expect(writeQuote("# Acme\n\n## Voice\n\nShort.\n", "New.")).toBe(
      "# Acme\n\n> New.\n\n## Voice\n\nShort.\n",
    );
  });
});

test("withFontName keeps the fallbacks", () => {
  expect(withFontName(`"Fraunces", serif`, "Lora")).toBe(`"Lora", serif`);
  expect(withFontName("Inter", "Lora")).toBe(`"Lora"`);
});

describe("code fences", () => {
  const md =
    "## Voice\n\nShort.\n\n```md\n## Not a section\n```\n\n## Rules\n\n- One.\n";

  test("a heading quoted in a fence is text, not a section", () => {
    expect(brandSections(md).map((s) => s.title)).toEqual(["Voice", "Rules"]);
    expect(sectionMarkdown(md, "Voice")).toBe(
      "Short.\n\n```md\n## Not a section\n```",
    );
  });

  test("writing around a fence leaves it whole", () => {
    expect(writeSection(md, "Rules", "- Two.")).toBe(
      "## Voice\n\nShort.\n\n```md\n## Not a section\n```\n\n## Rules\n\n- Two.\n",
    );
  });
});

describe("formats", () => {
  test("a formats section lands in the content group, before anything else", () => {
    const grouped = groupBrandSections([
      { title: "Formatos de post", summary: "" },
      { title: "Datas especiais", summary: "" },
    ]);
    const items = grouped.groups.flatMap((g) => g.items);
    expect(items.find((i) => i.id === "formats")?.sections).toHaveLength(1);
    expect(items.find((i) => i.id === "dates")?.sections).toHaveLength(1);
    expect(grouped.groups.at(-1)?.id).toBe("content");
  });

  test("a calendar or seasonality heading, accented or not, is special dates", () => {
    const titles = [
      "Calendário",
      "Calendário comercial",
      "Calendar",
      "Sazonalidade",
    ];
    const grouped = groupBrandSections(
      titles.map((title) => ({ title, summary: "" })),
    );
    const dates = grouped.groups
      .flatMap((g) => g.items)
      .find((i) => i.id === "dates");
    expect(dates?.sections.map((s) => s.title)).toEqual(titles);
    expect(grouped.more).toEqual([]);
  });

  test("a campaign heading is no longer read as special dates", () => {
    const grouped = groupBrandSections([{ title: "Campanhas", summary: "" }]);
    expect(grouped.more.map((s) => s.title)).toEqual(["Campanhas"]);
  });
});

describe("writeFrontmatter", () => {
  const body = "# Acme\n\n> Quote.\n\n## Voice\n\nShort.\n";

  test("adds a key and keeps the body byte for byte", () => {
    const md = `---\nname: Acme\n---\n\n${body}`;
    expect(writeFrontmatter(md, "site", "https://acme.com")).toBe(
      `---\nname: Acme\nsite: https://acme.com\n---\n\n${body}`,
    );
  });

  test("replaces a key in place", () => {
    const md = `---\nname: Acme\nlanguage: en\ndescription: x\n---\n${body}`;
    expect(writeFrontmatter(md, "language", "pt-BR")).toBe(
      `---\nname: Acme\nlanguage: pt-BR\ndescription: x\n---\n${body}`,
    );
  });

  test("an empty value removes the key", () => {
    const md = `---\nname: Acme\nsite: https://acme.com\n---\n${body}`;
    expect(writeFrontmatter(md, "site", "  ")).toBe(
      `---\nname: Acme\n---\n${body}`,
    );
    expect(writeFrontmatter(body, "site", "")).toBe(body);
  });

  test("creates the frontmatter when the file has none", () => {
    expect(writeFrontmatter(body, "language", "pt-BR")).toBe(
      `---\nlanguage: pt-BR\n---\n\n${body}`,
    );
  });

  test("a value is one line", () => {
    expect(writeFrontmatter("", "site", "https://a.com\n\nb")).toBe(
      "---\nsite: https://a.com b\n---\n\n",
    );
  });
});

describe("pickBrandDir", () => {
  test("the org's own folder wins", () => {
    expect(pickBrandDir("acme", ["zeta", "acme", "beta"])).toBe("acme");
  });

  test("otherwise the first in order, then the org's name", () => {
    expect(pickBrandDir("acme", ["zeta", "beta"])).toBe("beta");
    expect(pickBrandDir("acme", [])).toBe("acme");
  });
});

/** The labels the brand page writes as headings when someone fills an empty row. */
test("every row's own label finds its row again, in both languages", () => {
  const labels: Record<string, string[]> = {
    voice: ["Voice & tone", "Tom de voz"],
    audience: ["Audience", "Público"],
    examples: ["Example phrases", "Frases de exemplo"],
    rules: ["Rules", "Regras"],
    vocabulary: ["Vocabulary", "Vocabulário"],
    donts: ["Don'ts", "O que evitar"],
    values: ["Values", "Valores"],
    competitors: ["Competitors", "Concorrentes"],
    keywords: ["Keywords", "Palavras-chave"],
    dates: ["Special dates", "Datas especiais"],
    policies: ["Commercial policies", "Políticas comerciais"],
    formats: ["Formats", "Formatos"],
  };
  for (const [id, titles] of Object.entries(labels)) {
    const grouped = groupBrandSections(
      titles.map((title) => ({ title, summary: "" })),
    );
    const item = grouped.groups
      .flatMap((g) => g.items)
      .find((i) => i.id === id);
    expect(item?.sections.map((s) => s.title)).toEqual(titles);
  }
});

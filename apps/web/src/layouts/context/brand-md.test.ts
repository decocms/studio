import { describe, expect, test } from "bun:test";
import {
  brandDoDont,
  brandQuote,
  brandSections,
  fontName,
  groupBrandSections,
  withFontName,
  sectionMarkdown,
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

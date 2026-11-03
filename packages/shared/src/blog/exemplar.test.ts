import { describe, expect, test } from "bun:test";
import { brandExemplars, exemplarText } from "./exemplar";

const POST = "site/sections/Blog/Post";

describe("exemplarText", () => {
  test("reads like the page: headings by level, text without markup", () => {
    const text = exemplarText({
      sections: [
        { __resolveType: `${POST}/Heading.tsx`, text: "Tamanhos", level: "2" },
        { __resolveType: `${POST}/Heading.tsx`, text: "Bordo", level: "h3" },
        {
          __resolveType: `${POST}/Paragraph.tsx`,
          html: "<p>Até <strong>10 kg</strong> &amp; 55 cm.</p>",
        },
        { __resolveType: `${POST}/List.tsx`, items: "Leve\nRígida" },
      ],
    });
    expect(text).toBe(
      "## Tamanhos\n\n### Bordo\n\nAté 10 kg & 55 cm.\n\n- Leve\n- Rígida",
    );
  });

  test("a product block says what it shows, never which ids", () => {
    expect(
      exemplarText({
        sections: [
          {
            __resolveType: `${POST}/ProductShelf.tsx`,
            title: "Malas de bordo",
            products: ["vtex:product:1", "vtex:product:2"],
          },
        ],
      }),
    ).toBe("[ProductShelf: Malas de bordo — 2 product(s)]");
  });

  test("rows kept as JSON inside a string read as their text", () => {
    expect(
      exemplarText({
        sections: [
          {
            __resolveType: `${POST}/Steps.tsx`,
            steps: '[{"title":"Meça"},{"title":"Pese"}]',
          },
        ],
      }),
    ).toBe("[Steps] Meça; Pese");
  });

  test("stops at a line once it has shown enough", () => {
    const text = exemplarText(
      {
        sections: Array.from({ length: 10 }, () => ({
          __resolveType: `${POST}/Paragraph.tsx`,
          html: "x".repeat(100),
        })),
      },
      350,
    );
    expect(text.split("\n\n")).toHaveLength(4);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("brandExemplars", () => {
  const post = (slug: string, date: string, extra = {}) => ({
    __resolveType: "blog/loaders/Blogpost.ts",
    post: {
      title: slug,
      slug,
      date,
      ...extra,
      sections: [{ __resolveType: `${POST}/Paragraph.tsx`, html: slug }],
    },
  });
  const decofile = {
    "collections/blog/posts/a": post("antigo", "2023-01-01"),
    "collections/blog/posts/b": post("guia", "2025-05-05"),
    "collections/blog/posts/c": post("recente", "2026-10-27"),
    "collections/blog/posts/d": post("nosso", "2026-11-03", {
      planning: { format: { name: "Guia" } },
    }),
  };

  test("the posts the format cites, in its order", () => {
    expect(
      brandExemplars(decofile, ["guia", "antigo"]).map((e) => e.slug),
    ).toEqual(["guia", "antigo"]);
  });

  test("with none of them on the site, the newest the brand published itself", () => {
    expect(brandExemplars(decofile, ["sumiu"]).map((e) => e.slug)).toEqual([
      "recente",
    ]);
  });

  test("never more than two", () => {
    expect(
      brandExemplars(decofile, ["guia", "antigo", "recente"]),
    ).toHaveLength(2);
  });
});

import { describe, expect, test } from "bun:test";
import {
  applyLinkToBlocks,
  applyLinksToBlocks,
  postBodyText,
} from "./link-enrich";

const P = (html: string) => ({
  __resolveType: "blog/sections/blocks/Paragraph.tsx",
  html,
});
const H = (text: string) => ({
  __resolveType: "blog/sections/blocks/Heading.tsx",
  text,
});

describe("postBodyText", () => {
  test("reads paragraphs (tags stripped), headings, quotes and lists", () => {
    const body = postBodyText([
      H("Guia de malas"),
      P("Veja <strong>produtos de couro</strong> na loja."),
      { __resolveType: "blog/sections/blocks/Quote.tsx", quote: "Viaje leve" },
      { __resolveType: "blog/sections/blocks/List.tsx", items: "Um\nDois" },
      { __resolveType: "blog/sections/blocks/Divider.tsx" },
    ]);
    expect(body).toBe(
      "Guia de malas\nVeja produtos de couro na loja.\nViaje leve\nUm\nDois",
    );
  });
});

describe("applyLinkToBlocks", () => {
  test("wraps the first occurrence of a verbatim quote", () => {
    const { blocks, applied } = applyLinkToBlocks(
      [P("Veja produtos de couro na loja.")],
      "produtos de couro",
      "/blog/couro",
    );
    expect(applied).toBe(true);
    expect(blocks[0]?.html).toBe(
      'Veja <a href="/blog/couro">produtos de couro</a> na loja.',
    );
  });

  test("escapes the href and leaves other blocks untouched", () => {
    const { blocks } = applyLinkToBlocks(
      [H("Título"), P("uma mochila aqui")],
      "mochila",
      '/p?q=a&b="x"',
    );
    expect(blocks[1]?.html).toBe(
      'uma <a href="/p?q=a&amp;b=&quot;x&quot;">mochila</a> aqui',
    );
    expect(blocks[0]).toEqual(H("Título"));
  });

  test("does not link text already inside a link", () => {
    const result = applyLinkToBlocks(
      [P('já <a href="/x">produtos de couro</a> aqui')],
      "produtos de couro",
      "/blog/couro",
    );
    expect(result.applied).toBe(false);
    expect(result.blocks).toBe(result.blocks);
  });

  test("returns the same array when the quote is not found", () => {
    const blocks = [P("nada aqui")];
    const result = applyLinkToBlocks(blocks, "inexistente", "/x");
    expect(result.applied).toBe(false);
    expect(result.blocks).toBe(blocks);
  });
});

describe("applyLinksToBlocks", () => {
  test("applies a batch and counts how many landed", () => {
    const { blocks, applied } = applyLinksToBlocks(
      [P("uma mochila e produtos de couro")],
      [
        { quote: "mochila", href: "/blog/mochila" },
        { quote: "produtos de couro", href: "/blog/couro" },
        { quote: "não existe", href: "/x" },
      ],
    );
    expect(applied).toBe(2);
    expect(blocks[0]?.html).toBe(
      'uma <a href="/blog/mochila">mochila</a> e <a href="/blog/couro">produtos de couro</a>',
    );
  });
});

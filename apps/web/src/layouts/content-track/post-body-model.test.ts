import { setupComponentTest } from "../../../test/setup"; // happy-dom (DOMParser)
setupComponentTest();
import { describe, expect, test } from "bun:test";
import {
  bodyBlocks,
  componentText,
  type InlineNode,
  inlineNodes,
} from "./post-body-model";

describe("inlineNodes", () => {
  test("keeps the inline tags a paragraph may have", () => {
    expect(
      inlineNodes('Leve <strong>luz</strong> e <a href="/sala">sala</a>'),
    ).toEqual([
      { kind: "text", text: "Leve " },
      {
        kind: "element",
        tag: "strong",
        children: [{ kind: "text", text: "luz" }],
      },
      { kind: "text", text: " e " },
      {
        kind: "element",
        tag: "a",
        href: "/sala",
        children: [{ kind: "text", text: "sala" }],
      },
    ]);
  });

  test("drops code, images and handlers, and unwraps other tags", () => {
    const nodes = inlineNodes(
      '<script>alert(1)</script><img src=x onerror="alert(1)"><div>texto <em onclick="x()">dito</em></div>',
    );
    expect(nodes).toEqual([
      { kind: "text", text: "texto " },
      {
        kind: "element",
        tag: "em",
        children: [{ kind: "text", text: "dito" }],
      },
    ]);
  });

  test("a link that could run code keeps its text, not its address", () => {
    expect(inlineNodes('<a href="javascript:alert(1)">clique</a>')).toEqual([
      {
        kind: "element",
        tag: "a",
        children: [{ kind: "text", text: "clique" }],
      },
    ]);
  });

  test("a line break is a break, and empty HTML is nothing", () => {
    expect(inlineNodes("a<br>b")).toEqual([
      { kind: "text", text: "a" },
      { kind: "break" },
      { kind: "text", text: "b" },
    ]);
    expect(inlineNodes("   ")).toEqual([]);
  });
});

describe("bodyBlocks", () => {
  test("maps the blog's own blocks", () => {
    const blocks = bodyBlocks([
      { type: "Heading", props: { text: "Luz quente", level: "h3" } },
      { type: "Paragraph", props: { html: "Duas <b>luminárias</b>." } },
      {
        type: "List",
        props: { items: "Abajur\n\nLuminária de chão", style: "ordered" },
      },
      { type: "Quote", props: { quote: "Casa é onde a luz é boa." } },
    ]);
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "quote",
    ]);
    expect(blocks[0]).toEqual({
      kind: "heading",
      level: 3,
      text: "Luz quente",
    });
    expect(blocks[2]).toMatchObject({ kind: "list", ordered: true });
    expect(blocks[2]?.kind === "list" && blocks[2].items.length).toBe(2);
  });

  test("an image still to be drawn has no address yet", () => {
    expect(
      bodyBlocks([
        {
          type: "BlockImage",
          props: { url: "generate:um quarto", alt: "Quarto" },
        },
        { type: "BlockImage", props: { url: "https://cdn.example/a.webp" } },
        { type: "BlockImage", props: { url: "javascript:alert(1)" } },
      ]),
    ).toEqual([
      { kind: "image", url: null, alt: "Quarto" },
      { kind: "image", url: "https://cdn.example/a.webp", alt: "" },
      { kind: "image", url: null, alt: "" },
    ]);
  });

  test("other blocks show their name and products; empty ones are skipped", () => {
    expect(
      bodyBlocks([
        { type: "ProductShelf", props: {}, productIds: ["1", 2, "3"] },
        { type: "Paragraph", props: { html: "" } },
        { type: "Heading", props: {} },
        { props: {} },
      ]),
    ).toEqual([
      {
        kind: "component",
        name: "ProductShelf",
        title: [],
        lines: [],
        items: [],
        productIds: ["1", "3"],
      },
    ]);
  });
});

describe("componentText", () => {
  const text = (value: string): InlineNode[] => [{ kind: "text", text: value }];

  test("a callout reads as its title and its body", () => {
    expect(
      componentText({ title: "A resposta curta", body: "Leve 8 kg." }),
    ).toEqual({
      title: text("A resposta curta"),
      lines: [text("Leve 8 kg.")],
      items: [],
    });
  });

  test("steps and checklists kept as JSON read as their entries", () => {
    expect(
      componentText({
        title: "Em dois passos",
        steps:
          '[{"title": "Confira a regra", "description": "peso e medidas"}, {"title": "Pese a mala"}]',
      }).items,
    ).toEqual([text("Confira a regra — peso e medidas"), text("Pese a mala")]);
    expect(
      componentText({ items: '["Conferi o limite", "Somei o peso"]' }).items,
    ).toEqual([text("Conferi o limite"), text("Somei o peso")]);
  });

  test("a call to action shows its words, not its address", () => {
    expect(
      componentText({ text: "Ver malas", href: "https://loja.example/malas" }),
    ).toEqual({ title: [], lines: [text("Ver malas")], items: [] });
  });

  test("addresses, image notes and settings are not text; broken JSON is", () => {
    expect(
      componentText({
        caption: "https://cdn.example/a.webp",
        note: "generate:uma mala aberta",
        variant: "tip",
        body: "[oops",
      }).lines,
    ).toEqual([text("[oops")]);
  });

  test("code in a body is dropped and its inline tags kept", () => {
    expect(
      componentText({ body: "Leve <script>alert(1)</script><b>pouco</b>" })
        .lines,
    ).toEqual([
      [
        { kind: "text", text: "Leve " },
        { kind: "element", tag: "b", children: text("pouco") },
      ],
    ]);
  });
});

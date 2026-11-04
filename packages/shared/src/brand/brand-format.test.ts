import { describe, expect, it } from "bun:test";
import {
  formatFileText,
  formatIdOf,
  newFormatId,
  parseFormatFile,
} from "./brand-format";

const FILE = `---
name: Guia de compra para datas
summary: "Ajuda a escolher bem numa data de compra"
length: 1.200–1.800 palavras
---

## Para que serve

Compara opções e leva à vitrine da campanha.
`;

describe("parseFormatFile", () => {
  it("reads the frontmatter and keeps the body as the brief", () => {
    expect(parseFormatFile(FILE, "guia-de-compra")).toEqual({
      id: "guia-de-compra",
      name: "Guia de compra para datas",
      summary: "Ajuda a escolher bem numa data de compra",
      length: "1.200–1.800 palavras",
      value:
        "## Para que serve\n\nCompara opções e leva à vitrine da campanha.",
    });
  });

  it("leaves out what the file does not say", () => {
    expect(
      parseFormatFile("---\nname: Lista\n---\nCinco itens.", "lista"),
    ).toEqual({ id: "lista", name: "Lista", value: "Cinco itens." });
  });

  it("is no format without a name", () => {
    expect(parseFormatFile("---\nsummary: x\n---\nbody", "x")).toBeNull();
    expect(parseFormatFile("Just a brief.", "x")).toBeNull();
    expect(parseFormatFile('---\nname: ""\n---\nbody', "x")).toBeNull();
  });
});

describe("formatIdOf", () => {
  it("takes the id from a markdown file's name", () => {
    expect(formatIdOf("brands/acme/formats/guia-de-compra.md")).toBe(
      "guia-de-compra",
    );
  });

  it("reads a file named in the brand's own language, accents and all", () => {
    expect(formatIdOf("brands/acme/formats/promoção-relâmpago.md")).toBe(
      "promoção-relâmpago",
    );
  });

  it("skips anything that is not a format file", () => {
    expect(formatIdOf("brands/acme/formats/notes.txt")).toBeNull();
    expect(formatIdOf("brands/acme/formats/.md")).toBeNull();
    expect(formatIdOf("brands/acme/formats/com espaço.md")).toBeNull();
  });
});

describe("formatFileText", () => {
  it("writes what parseFormatFile reads back", () => {
    const text = formatFileText({
      name: "Guia\nprático",
      summary: "Resolve um problema",
      value: "\n## Estrutura\n\n1. Abertura\n",
    });
    expect(text).toBe(
      "---\nname: Guia prático\nsummary: Resolve um problema\n---\n\n## Estrutura\n\n1. Abertura\n",
    );
    expect(parseFormatFile(text, "guia")).toEqual({
      id: "guia",
      name: "Guia prático",
      summary: "Resolve um problema",
      value: "## Estrutura\n\n1. Abertura",
    });
  });
});

describe("newFormatId", () => {
  it("folds accents and numbers past the ids taken", () => {
    expect(newFormatId("Promoção de verão!", [])).toBe("promocao-de-verao");
    expect(
      newFormatId("Promoção de verão", [
        "promocao-de-verao",
        "promocao-de-verao-2",
      ]),
    ).toBe("promocao-de-verao-3");
  });

  it("falls back when the name has nothing to keep", () => {
    expect(newFormatId("!!!", [])).toBe("format");
  });
});

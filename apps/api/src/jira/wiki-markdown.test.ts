import { describe, expect, it } from "bun:test";
import { wikiToMarkdown } from "./wiki-markdown";

describe("wikiToMarkdown", () => {
  it("converts bold and strips color, keeping literal brackets", () => {
    expect(
      wikiToMarkdown("*QA — resultado:* {color:#FF991F}*[ APROVADO ]*{color}"),
    ).toBe("**QA — resultado:** **[ APROVADO ]**");
  });

  it("converts headings with inline marks", () => {
    expect(wikiToMarkdown("h3. *Novo Protótipo:*")).toBe(
      "### **Novo Protótipo:**",
    );
  });

  it("converts links, monospace, and italic", () => {
    expect(
      wikiToMarkdown(
        "PR [#42|https://example.com/pr/42] na branch {{ABC-1}}, _urgente_.",
      ),
    ).toBe("PR [#42](https://example.com/pr/42) na branch `ABC-1`, *urgente*.");
  });

  it("unwraps bare bracketed urls and converts images", () => {
    expect(
      wikiToMarkdown(
        "[https://example.com] e !https://example.com/a.png|width=200!",
      ),
    ).toBe("https://example.com e ![](https://example.com/a.png)");
  });

  it("leaves code blocks untouched, with language", () => {
    expect(
      wikiToMarkdown("antes\n{code:js}\nconst a = *not bold*;\n{code}\ndepois"),
    ).toBe("antes\n```js\nconst a = *not bold*;\n```\ndepois");
  });

  it("quotes {quote} blocks and converts their contents", () => {
    expect(
      wikiToMarkdown("{quote}\n*importante*\nsegunda linha\n{quote}"),
    ).toBe("> **importante**\n> segunda linha");
  });

  it("converts lists and horizontal rules", () => {
    expect(wikiToMarkdown("* um\n** dois\n# primeiro\n----")).toBe(
      "* um\n  - dois\n1. primeiro\n---",
    );
  });

  it("converts tables with inline marks in cells", () => {
    expect(wikiToMarkdown("||Nome||*Nota*||\n|a|b|")).toBe(
      "| Nome | **Nota** |\n| --- | --- |\n| a | b |",
    );
  });

  it("leaves ambiguous marks alone", () => {
    expect(wikiToMarkdown("snake_case, 2 * 3 = 6 e um * solto")).toBe(
      "snake_case, 2 * 3 = 6 e um * solto",
    );
  });
});

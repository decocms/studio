import { describe, expect, it } from "bun:test";
import { collectWikiMentionAccountIds, wikiToMarkdown } from "./wiki-markdown";

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

  it("resolves accountid mentions to display names", () => {
    expect(
      wikiToMarkdown(
        "[~accountid:557058:abc-123] revisa com [~accountid:712020:def-456]",
        new Map([
          ["557058:abc-123", "Ana Souza"],
          ["712020:def-456", "Bruno Lima"],
        ]),
      ),
    ).toBe("@Ana Souza revisa com @Bruno Lima");
  });

  it("renders unknown account ids as @unknown, never the raw id", () => {
    expect(wikiToMarkdown("cc [~accountid:557058:abc-123]")).toBe(
      "cc @unknown",
    );
  });

  it("leaves non-accountid bracket-tilde text alone", () => {
    expect(wikiToMarkdown("lookup[~key], arr[~1], [~], regex [^a-z]")).toBe(
      "lookup[~key], arr[~1], [~], regex [^a-z]",
    );
  });

  it("leaves mentions inside code blocks byte-exact", () => {
    expect(
      wikiToMarkdown(
        "{code}\n[~accountid:557058:abc-123]\n{code}",
        new Map([["557058:abc-123", "Ana Souza"]]),
      ),
    ).toBe("```\n[~accountid:557058:abc-123]\n```");
  });

  it("does not mistake a link for a mention", () => {
    expect(wikiToMarkdown("[~x|https://example.com/a]")).toBe(
      "[~x](https://example.com/a)",
    );
  });

  it("neutralizes wiki and markdown markup inside a display name", () => {
    expect(
      wikiToMarkdown(
        "cc [~accountid:a] ok",
        new Map([["a", "Ana _Nick_ Souza"]]),
      ),
    ).toBe("cc @Ana \\_Nick\\_ Souza ok");
    expect(
      wikiToMarkdown("cc [~accountid:a]", new Map([["a", "Ana *Nick*"]])),
    ).toBe("cc @Ana \\*Nick\\*");
  });

  it("keeps a pipe in a display name from splitting a table cell", () => {
    expect(
      wikiToMarkdown("|[~accountid:c]|done|", new Map([["c", "Cid | Team"]])),
    ).toBe("| @Cid \\| Team | done |");
  });

  it("does not collect account ids it will never render", () => {
    expect(
      collectWikiMentionAccountIds(
        "{code}\n[~accountid:X:1]\n{code}\ncc [~accountid:Y:2]",
      ),
    ).toEqual(["Y:2"]);
  });

  it("strips a source sentinel so it cannot forge a mention reference", () => {
    const nul = String.fromCharCode(0);
    expect(wikiToMarkdown(`a${nul}0${nul}b [~accountid:x]`)).toBe(
      "a0b @unknown",
    );
  });

  it("leaves ambiguous marks alone", () => {
    expect(wikiToMarkdown("snake_case, 2 * 3 = 6 e um * solto")).toBe(
      "snake_case, 2 * 3 = 6 e um * solto",
    );
  });
});

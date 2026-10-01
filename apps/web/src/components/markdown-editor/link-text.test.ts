import { describe, expect, it } from "bun:test";
import { marked } from "marked";
import { escapeLinkText, unescapeLinkText } from "./link-text";

/** The link token the editor reads a stored attachment back from. */
function linkToken(markdown: string) {
  const [paragraph] = marked.lexer(markdown);
  const link =
    paragraph?.type === "paragraph" ? paragraph.tokens?.[0] : undefined;
  if (link?.type !== "link") throw new Error(`no link in ${markdown}`);
  return link;
}

describe("escapeLinkText", () => {
  for (const name of [
    "report *final*.pdf",
    "_draft_ notes.pdf",
    "spec[2].pdf",
    "a\\b`c`~~d~~.txt",
    "<b>&amp;.pdf",
    "plain name.pdf",
  ]) {
    it(`keeps ${JSON.stringify(name)} whole as a link's text`, () => {
      const link = linkToken(`[${escapeLinkText(name)}](/x)`);

      expect(link.href).toBe("/x");
      expect(
        link.tokens?.every((t) => t.type === "text" || t.type === "escape"),
      ).toBe(true);
      expect(unescapeLinkText(link.text)).toBe(name);
    });
  }

  it("leaves a name without markdown characters as it was", () => {
    expect(escapeLinkText("relatório (v2).pdf")).toBe("relatório (v2).pdf");
  });
});

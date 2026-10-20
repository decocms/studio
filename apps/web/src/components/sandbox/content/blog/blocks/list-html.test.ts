import "../../../../../../test/setup";
import { describe, expect, it } from "bun:test";
import { listHtmlToRows, rowsToListHtml } from "./list-html";

describe("rowsToListHtml", () => {
  it("builds a bulleted list from newline-separated rows", () => {
    expect(rowsToListHtml("a\nb", false)).toBe(
      "<ul><li><p>a</p></li><li><p>b</p></li></ul>",
    );
  });

  it("builds a numbered list when the style is ordered", () => {
    expect(rowsToListHtml("a", true)).toBe("<ol><li><p>a</p></li></ol>");
  });

  it("renders one empty item for empty content", () => {
    expect(rowsToListHtml("", false)).toBe("<ul><li><p></p></li></ul>");
  });

  it("keeps a row's inline markup as markup, not text", () => {
    expect(
      rowsToListHtml('<strong>hi</strong>\n<a href="/x">y</a>', false),
    ).toBe(
      '<ul><li><p><strong>hi</strong></p></li><li><p><a href="/x">y</a></p></li></ul>',
    );
  });
});

describe("listHtmlToRows", () => {
  it("unwraps the paragraph TipTap puts inside each list item", () => {
    expect(
      listHtmlToRows("<ul><li><p>a</p></li><li><p>b</p></li></ul>"),
    ).toEqual(["a", "b"]);
  });

  it("preserves inline marks and links", () => {
    expect(
      listHtmlToRows(
        '<ol><li><p><strong>bold</strong> and <a href="https://x.com" target="_blank">link</a></p></li></ol>',
      ),
    ).toEqual([
      '<strong>bold</strong> and <a href="https://x.com" target="_blank">link</a>',
    ]);
  });

  it("ignores nested lists' items so a row is never duplicated", () => {
    expect(
      listHtmlToRows(
        "<ul><li><p>a</p><ul><li><p>nested</p></li></ul></li></ul>",
      ),
    ).toEqual(["<p>a</p><ul><li><p>nested</p></li></ul>"]);
  });

  it("falls back to top-level blocks when the list is gone", () => {
    expect(listHtmlToRows("<p>just text</p>")).toEqual(["just text"]);
  });

  it("returns a single empty row for an empty document", () => {
    expect(listHtmlToRows("")).toEqual([""]);
  });

  it("round-trips rows through the editor shape", () => {
    const items = "first\n<em>second</em>";
    expect(listHtmlToRows(rowsToListHtml(items, true)).join("\n")).toBe(items);
  });
});

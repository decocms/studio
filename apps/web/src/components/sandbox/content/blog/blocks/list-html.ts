/**
 * Bridge between deco's List storage (newline-separated `items` + `style`)
 * and TipTap's list document. Each row is an item's *inline* HTML, so marks
 * survive; plain-text rows round-trip unchanged.
 */

/** Build the editor's initial document from the stored rows. */
export function rowsToListHtml(items: string, ordered: boolean): string {
  const rows = items.length ? items.split("\n") : [""];
  const tag = ordered ? "ol" : "ul";
  const lis = rows.map((row) => `<li><p>${row}</p></li>`).join("");
  return `<${tag}>${lis}</${tag}>`;
}

/**
 * Serialize the editor's HTML back to rows. Only top-level list items are
 * read (nesting is blocked in the editor, so it can't be produced here) and
 * the paragraph TipTap wraps each item in is unwrapped, keeping rows inline.
 * When the document holds no list at all — the user emptied it down to a bare
 * paragraph — each block becomes one row so nothing is silently dropped.
 */
export function listHtmlToRows(html: string): string[] {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const items = Array.from(
    body.querySelectorAll(":scope > ul > li, :scope > ol > li"),
  );
  const blocks = items.length ? items : Array.from(body.children);
  if (blocks.length === 0) return [""];
  return blocks.map((block) => {
    const onlyChild = block.children.length === 1 ? block.children[0] : null;
    const inner =
      onlyChild?.tagName === "P" ? onlyChild.innerHTML : block.innerHTML;
    return inner.trim();
  });
}

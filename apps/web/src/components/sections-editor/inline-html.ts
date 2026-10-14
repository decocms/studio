/**
 * Serialize an editor's HTML without a block wrapper, for values that get
 * injected where a `<p>`/`<div>` can't legally nest (inside another `<p>`, a
 * table cell, a phrasing-only context). ProseMirror always keeps a top-level
 * block internally, so we unwrap it on output: a single block returns its
 * inline contents; multiple blocks join with `<br>`. This round-trips — TipTap
 * re-wraps the inline HTML in a paragraph on load.
 */
export function toInlineHtml(html: string): string {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const blocks = Array.from(body.children);
  if (blocks.length === 0) return body.innerHTML;
  return blocks.map((block) => block.innerHTML).join("<br>");
}

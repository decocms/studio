/** A line that opens a list item: `- foo`, `* foo`, `1. foo`, `2) foo`. */
const LIST_MARKER = /^(\s*)([-*+]|\d+[.)])\s+\S/;

/** A line that opens or closes a fenced code block. */
const FENCE = /^\s*(```|~~~)/;

/** An indented line that continues the previous one rather than starting a new
 *  block of its own. */
const CONTINUATION = /^\s+(?![-*+>#]|\d+[.)]\s)\S/;

/**
 * Join a list item's hard-wrapped continuation lines back onto the item.
 *
 * The editor's markdown parser turns
 *
 *     1. um critério que passa da margem
 *        e continua aqui.
 *
 * into a list item holding only "um critério que passa da margem" plus an empty
 * hard break: the tail is DROPPED. Since the dialog autosaves, that truncated
 * parse is what gets written back, so wrapped markdown (which is how agents and
 * anyone with a wrapping editor write it) loses text on open.
 *
 * Fixed on the way in rather than in the serializer because the text is already
 * gone by then. Paragraphs outside lists round-trip fine and are left alone, as
 * is anything inside a fenced code block.
 */
export function unwrapListContinuations(markdown: string): string {
  const out: string[] = [];
  let inFence = false;
  let inListItem = false;

  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      inListItem = false;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (LIST_MARKER.test(line)) {
      inListItem = true;
      out.push(line);
      continue;
    }
    // A blank line ends the item's paragraph, so what follows is its own block.
    if (!line.trim()) {
      inListItem = false;
      out.push(line);
      continue;
    }
    if (inListItem && CONTINUATION.test(line)) {
      out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`;
      continue;
    }
    inListItem = false;
    out.push(line);
  }

  return out.join("\n");
}

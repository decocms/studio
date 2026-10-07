import type { Token } from "marked";

export type MarkdownRun =
  | { kind: "block"; index: number; block: Token }
  | { kind: "gallery"; index: number; images: Token[] };

/** A paragraph of nothing but images, and the whitespace between them. */
function isImageParagraph(block: Token): boolean {
  if (block.type !== "paragraph" || !block.tokens) return false;
  return (
    block.tokens.some((token) => token.type === "image") &&
    block.tokens.every(
      (token) =>
        token.type === "image" ||
        token.type === "br" ||
        (token.type === "text" && !token.raw.trim()),
    )
  );
}

/**
 * Gathers image-only paragraphs that follow one another, across the blank
 * lines between them, into one gallery run. Every other block stays its own
 * run, so text between two images keeps them apart.
 */
export function groupImageRuns(blocks: Token[]): MarkdownRun[] {
  const runs: MarkdownRun[] = [];
  blocks.forEach((block, index) => {
    if (!isImageParagraph(block)) {
      runs.push({ kind: "block", index, block });
      return;
    }
    const last = runs.at(-1);
    const spaced = last?.kind === "block" && last.block.type === "space";
    const gallery = spaced ? runs.at(-2) : last;
    if (gallery?.kind !== "gallery") {
      runs.push({ kind: "gallery", index, images: [block] });
      return;
    }
    if (spaced) runs.pop();
    gallery.images.push(block);
  });
  return runs;
}

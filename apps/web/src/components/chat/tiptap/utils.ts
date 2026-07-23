import type { TiptapDoc } from "../types";

/**
 * Check if a Tiptap document is empty
 */
export function isTiptapDocEmpty(doc: TiptapDoc | null | undefined): boolean {
  if (!doc) return true;
  if (!doc.content || doc.content.length === 0) return true;

  // Check if all content nodes are empty
  return doc.content.every((node) => {
    if (node.type === "paragraph") {
      if (!node.content || node.content.length === 0) return true;
      return node.content.every(
        (child) =>
          child.type === "hardBreak" ||
          (child.type === "text" && (!child.text || child.text.trim() === "")),
      );
    }
    return false;
  });
}

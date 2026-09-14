/**
 * Plain text ↔ Tiptap doc, for the prompt fields that STORE a string.
 *
 * The chat's composer stores its doc, so a mention stays a pill across
 * reloads. A saved prompt — a Jira column rule, say — is a string the server
 * reads, and it must stay one: the whole reason for editing it in this editor
 * is the `/` menu, which bakes a skill's markdown in at the moment you pick
 * it. Once baked it is your text, and it round-trips as text.
 *
 * So the pill is an insertion affordance, not a stored reference. Reopen the
 * field and you see the words the run will see, which is the point.
 */

import type { TiptapDoc } from "@decocms/shared/tiptap";
import { derivePartsFromTiptapDoc } from "../derive-parts";

/** One paragraph per line; an empty line is an empty paragraph, so blank-line
 *  structure (markdown's paragraph break) survives the round trip. */
export function plainTextToTiptapDoc(text: string): TiptapDoc {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      ...(line === "" ? {} : { content: [{ type: "text", text: line }] }),
    })),
  };
}

/**
 * The text a run would receive: inline words first, then each mention's baked
 * content, exactly as `derivePartsFromTiptapDoc` orders them for chat. Joined
 * with a blank line because every part is a block, and a skill's markdown
 * abutting the previous line would fold into its paragraph.
 */
export function tiptapDocToPlainText(doc: TiptapDoc | undefined): string {
  return derivePartsFromTiptapDoc(doc)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n")
    .trim();
}

import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import Image from "@tiptap/extension-image";
import Highlight from "@tiptap/extension-highlight";
import { TableKit } from "@tiptap/extension-table";

/**
 * The schema of a legacy post body: the marks and nodes the deco admin's
 * editor wrote into `post.content`, so a body saved there round-trips
 * unchanged. HTML outside it (scripts, iframes, classes) is dropped, as the
 * admin dropped it.
 *
 * Images are inline, as the admin wrote them: an image sits inside a
 * paragraph, with its caption as a sibling span. Tables are kept, not
 * authored; the admin had no table controls either.
 */
export function legacyContentExtensions(): Extensions {
  return [
    StarterKit.configure({
      // Each link keeps its own `target`/`rel`; the link control sets them.
      link: { openOnClick: false, HTMLAttributes: {} },
      // The admin never appended an empty paragraph after a final list or image.
      trailingNode: false,
    }),
    TextAlign.configure({
      types: [
        "heading",
        "paragraph",
        "codeBlock",
        "image",
        "bulletList",
        "orderedList",
        "blockquote",
      ],
    }),
    TextStyle,
    FontSize,
    Color,
    Image.configure({ inline: true, allowBase64: false }),
    Highlight.configure({ multicolor: true }),
    TableKit.configure({ table: { resizable: false } }),
  ];
}

import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import type { Extensions } from "@tiptap/core";
import { MarkdownImage } from "./image-node";

/**
 * The editor's schema. Kept separate from the component so the markdown
 * round-trip can be asserted without mounting React.
 */
export function markdownEditorExtensions(placeholder = ""): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Markdown has no underline, so the mark would silently vanish on save.
      // Not offering it beats losing the user's formatting.
      underline: false,
      link: {
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      },
    }),
    Placeholder.configure({ placeholder }),
    MarkdownImage,
    Markdown.configure({
      markedOptions: {
        // These values used to be typed into a plain textarea, where one
        // newline WAS a line break. Without this, every existing multi-line
        // description reflows into a single paragraph the first time it opens.
        breaks: true,
      },
    }),
  ];
}

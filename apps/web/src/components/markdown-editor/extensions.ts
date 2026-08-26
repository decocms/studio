import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import type { Extensions } from "@tiptap/core";
import { MarkdownAttachment } from "./attachment-node";
import { MarkdownMention } from "./mention-node";
import { mentionIdFromHref } from "@decocms/shared/mentions";
import {
  mentionSuggestionExtension,
  type MentionMenuStore,
} from "./mention-suggestion";
import { MarkdownImage } from "./image-node";
import { isEditorFileUrl } from "./uploads";

const LINK_OPTIONS = {
  openOnClick: false,
  autolink: true,
  HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
} as const;

/**
 * An uploaded attachment and a mention are both stored as plain markdown
 * links, so recognizing them on the way back in has to happen here: the `link`
 * token belongs to Link, and the parser only runs the first handler registered
 * for a token. Anything that isn't one of ours keeps Link's own behaviour.
 */
const AttachmentAwareLink = Link.extend({
  parseMarkdown: (token, helpers) => {
    const href = typeof token.href === "string" ? token.href : "";
    if (isEditorFileUrl(href)) {
      return helpers.createNode("attachment", { href, name: token.text ?? "" });
    }
    const mentionId = mentionIdFromHref(href);
    if (mentionId) {
      // The link text is `@Name`; the chip renders its own `@`.
      return helpers.createNode("mention", {
        id: mentionId,
        name: (token.text ?? "").replace(/^@/, ""),
      });
    }
    return helpers.applyMark("link", helpers.parseInline(token.tokens ?? []), {
      href,
      title: token.title || null,
    });
  },
});

/**
 * The editor's schema. Kept separate from the component so the markdown
 * round-trip can be asserted without mounting React.
 */
export function markdownEditorExtensions(
  placeholder = "",
  /** Omitted where mentions don't apply — no store, no `@` picker. */
  mentionStore?: MentionMenuStore,
): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Markdown has no underline, so the mark would silently vanish on save.
      // Not offering it beats losing the user's formatting.
      underline: false,
      // Replaced by AttachmentAwareLink below, same options.
      link: false,
    }),
    AttachmentAwareLink.configure(LINK_OPTIONS),
    Placeholder.configure({ placeholder }),
    MarkdownImage,
    MarkdownAttachment,
    MarkdownMention,
    ...(mentionStore ? [mentionSuggestionExtension(mentionStore)] : []),
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

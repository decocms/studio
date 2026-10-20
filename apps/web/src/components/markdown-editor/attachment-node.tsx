import { mergeAttributes, Node } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { X } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import {
  ATTACHMENT_CHIP_CLASS,
  AttachmentChipContent,
} from "./attachment-chip";

/** The chip inside the editor; inline, because in markdown it IS a link. */
function AttachmentNodeView({
  node,
  selected,
  editor,
  deleteNode,
}: NodeViewProps) {
  const t = useT();
  const href = typeof node.attrs.href === "string" ? node.attrs.href : "";
  const name = typeof node.attrs.name === "string" ? node.attrs.name : "";

  return (
    <NodeViewWrapper
      as="span"
      className={cn(
        ATTACHMENT_CHIP_CLASS,
        // An atom's label isn't text the caret enters; a posted chip's is.
        "select-none",
        selected && "ring-2 ring-ring ring-offset-2 ring-offset-background",
      )}
    >
      <AttachmentChipContent href={href} name={name}>
        {editor.isEditable && (
          <button
            type="button"
            aria-label={t("markdownEditor.removeFile")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={deleteNode}
            className="shrink-0 rounded-lg p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X size={14} />
          </button>
        )}
      </AttachmentChipContent>
    </NodeViewWrapper>
  );
}

/** A file name may contain brackets; unescaped they'd truncate the link text. */
function escapeLinkText(text: string): string {
  return text.replace(/([[\]])/g, "\\$1");
}

/**
 * Attachment chip for a non-image upload.
 *
 * On the wire it is a plain markdown link — `[spec.pdf](<upload url>)` — so the
 * description stays legible markdown and the agent reading it as prompt context
 * sees a named file it can fetch. Reading one back is the Link extension's job
 * (see `extensions.ts`): the `link` token is Link's, and only the first handler
 * registered for a token runs.
 */
export const MarkdownAttachment = Node.create({
  name: "attachment",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      href: {
        default: null,
        parseHTML: (element) => element.getAttribute("href"),
        renderHTML: (attributes) =>
          attributes.href ? { href: attributes.href } : {},
      },
      name: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute("data-name") || element.textContent,
        renderHTML: (attributes) =>
          attributes.name ? { "data-name": attributes.name } : {},
      },
    };
  },

  // Round-trips a chip copied inside the editor (the clipboard carries HTML).
  parseHTML() {
    return [{ tag: "a[data-attachment]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "a",
      mergeAttributes(HTMLAttributes, { "data-attachment": "" }),
      typeof node.attrs.name === "string" ? node.attrs.name : "",
    ];
  },

  renderMarkdown: (node) => {
    const href = typeof node.attrs?.href === "string" ? node.attrs.href : "";
    const name = typeof node.attrs?.name === "string" ? node.attrs.name : "";
    return `[${escapeLinkText(name)}](${href})`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentNodeView);
  },
});

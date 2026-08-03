import { mergeAttributes, Node } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { Download01, File02, X } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";

/**
 * A file with nothing to preview (pdf, docx, pptx, txt, …), rendered as a chip
 * you can download. Inline, because in markdown it IS a link — see
 * `renderMarkdown` below.
 */
function AttachmentNodeView({
  node,
  selected,
  editor,
  deleteNode,
}: NodeViewProps) {
  const t = useT();
  const href = typeof node.attrs.href === "string" ? node.attrs.href : "";
  const attrName = typeof node.attrs.name === "string" ? node.attrs.name : "";
  const name = attrName || t("markdownEditor.fileNameFallback");

  return (
    <NodeViewWrapper
      as="span"
      className={cn(
        "mx-0.5 inline-flex max-w-full select-none items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1 align-middle text-sm text-foreground",
        selected && "ring-2 ring-ring ring-offset-2 ring-offset-background",
      )}
    >
      <File02 size={14} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{name}</span>
      {/* The stored file name is a UUID, so `download` is what gives the saved
          file the name it was uploaded with. */}
      <a
        href={href}
        download={name}
        aria-label={t("markdownEditor.downloadFile", { name })}
        // The node view sits outside the editor's own event handling, so a
        // plain click would first move the selection into the chip. Keep the
        // mousedown away from PM — the click itself still fires.
        onMouseDown={(e) => e.preventDefault()}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Download01 size={14} />
      </a>
      {editor.isEditable && (
        <button
          type="button"
          aria-label={t("markdownEditor.removeFile")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={deleteNode}
          className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X size={14} />
        </button>
      )}
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

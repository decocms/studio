import Image from "@tiptap/extension-image";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { X } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";

/**
 * Renders the image itself instead of its markdown source, with a hover
 * affordance to drop it. Without a node view the editor shows the raw
 * `![alt](url)` text, which is exactly what the markdown syntax is meant to
 * hide.
 */
function ImageNodeView({ node, selected, editor, deleteNode }: NodeViewProps) {
  const t = useT();
  const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";

  return (
    <NodeViewWrapper className="group/image relative my-3 w-fit max-w-full">
      <img
        src={src}
        alt={alt || t("markdownEditor.imageAltFallback")}
        draggable={false}
        className={cn(
          "max-h-[420px] max-w-full rounded-lg border border-border object-contain",
          selected && "ring-2 ring-ring ring-offset-2 ring-offset-background",
        )}
      />
      {editor.isEditable && (
        <button
          type="button"
          aria-label={t("markdownEditor.removeImage")}
          // The node view sits outside the editor's own event handling, so a
          // plain click would first move the selection into the image and only
          // then delete — losing the caret. Keep the mousedown away from PM.
          onMouseDown={(e) => e.preventDefault()}
          onClick={deleteNode}
          className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/image:opacity-100"
        >
          <X size={14} />
        </button>
      )}
    </NodeViewWrapper>
  );
}

/**
 * Block image, rendered as a preview. `extend` only adds the node view, so the
 * extension's own `parseMarkdown`/`renderMarkdown` still round-trip it as
 * `![alt](src)`.
 *
 * `allowBase64: false`: a pasted screenshot is uploaded and referenced by URL,
 * so a base64 node could only arrive via pasted foreign HTML — and inlining a
 * multi-megabyte data URL would bloat every read of the description.
 */
export const MarkdownImage = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
}).configure({ inline: false, allowBase64: false });

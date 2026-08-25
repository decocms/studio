import { mergeAttributes, Node } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { cn } from "@decocms/ui/lib/utils.ts";
import { mentionMarkdown } from "@decocms/shared/mentions";

/**
 * A mentioned member, as a chip. Not editable and not selectable text: the id
 * is what notifies, so a half-deleted name must not survive as a live mention.
 * Backspace removes the whole chip, which is what `atom` buys.
 */
function MentionNodeView({ node, selected }: NodeViewProps) {
  const name = typeof node.attrs.name === "string" ? node.attrs.name : "";
  return (
    <NodeViewWrapper
      as="span"
      data-testid="mention-chip"
      className={cn(
        "select-none rounded px-1 font-medium text-primary",
        // Tinted rather than bordered — a mention sits mid-sentence, and a
        // chip with an outline would break the line of the text around it.
        "bg-primary/10",
        selected && "ring-2 ring-ring",
      )}
    >
      @{name}
    </NodeViewWrapper>
  );
}

/**
 * `@`-mention of an org member.
 *
 * On the wire it's the plain markdown link `@decocms/shared/mentions` defines,
 * so the body stays markdown for everything downstream that isn't this editor
 * (the agent's prompt context, the Jira mirror, the comment renderer). Reading
 * one back is the Link extension's job — see `extensions.ts`, where the `link`
 * token handler branches on the href.
 */
export const MarkdownMention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  // Not draggable: dropping a mention somewhere is a way to duplicate one.
  selectable: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-mention-id"),
        renderHTML: (attributes) =>
          attributes.id ? { "data-mention-id": attributes.id } : {},
      },
      name: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-mention-name"),
        renderHTML: (attributes) =>
          attributes.name ? { "data-mention-name": attributes.name } : {},
      },
    };
  },

  // Round-trips a chip copied inside the editor (the clipboard carries HTML).
  parseHTML() {
    return [{ tag: "span[data-mention-id]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes),
      `@${typeof node.attrs.name === "string" ? node.attrs.name : ""}`,
    ];
  },

  renderMarkdown: (node) => {
    const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
    const name = typeof node.attrs?.name === "string" ? node.attrs.name : "";
    return id ? mentionMarkdown(id, name) : `@${name}`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionNodeView);
  },
});

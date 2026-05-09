import { toTitleCase } from "@/web/components/chat/message/parts/tool-call-part/utils.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { JSONContent, Node } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type Editor,
  type NodeViewProps,
  type Range,
} from "@tiptap/react";

// ============================================================================
// Mention Attributes (shared between MentionNode and mention insertion)
// ============================================================================

export interface MentionAttrs<T = unknown> {
  /** Unique identifier for the mention */
  id: string;
  /** Machine-readable name */
  name: string;
  /** Additional metadata (e.g., prompt messages) */
  metadata: T;
  /** Character that triggered the mention ("/" prompts+resources, "@" agents) */
  char?: "/" | "@";
  /** Original prompt argument values used to render this mention. Present only
   * for slash-prompt mentions whose prompt declared arguments — enables
   * click-to-edit. */
  values?: Record<string, string>;
}

// ============================================================================
// Insert Mention Helper
// ============================================================================

/**
 * Inserts a mention node into the editor at the specified range.
 * @param editor - The Tiptap editor instance
 * @param range - The range where the mention should be inserted
 * @param attrs - The mention attributes
 */
export function insertMention<T>(
  editor: Editor,
  range: Range,
  attrs: MentionAttrs<T>,
): void {
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      createMentionDoc<T>(attrs),
      { type: "text", text: " " },
    ])
    .run();
}

export function createMentionDoc<T>(attrs: MentionAttrs<T>): JSONContent {
  return {
    type: "mention",
    attrs: attrs satisfies MentionAttrs<T>,
  };
}

// ============================================================================
// React Node View Component
// ============================================================================

export const MENTION_EDIT_EVENT = "mention:edit";

export interface MentionEditEventDetail {
  pos: number;
  attrs: MentionAttrs;
}

function MentionNodeView(props: NodeViewProps) {
  const { node, selected, view, getPos } = props;
  const { name, char, values } = node.attrs as MentionAttrs;

  const isSelected = selected && view.editable;
  const isAgent = char === "@";
  const isEditablePrompt =
    char === "/" &&
    view.editable &&
    !!values &&
    typeof values === "object" &&
    Object.keys(values).length > 0;

  const handleClick = () => {
    if (!isEditablePrompt) return;
    const pos = typeof getPos === "function" ? getPos() : null;
    if (typeof pos !== "number") return;
    view.dom.dispatchEvent(
      new CustomEvent<MentionEditEventDetail>(MENTION_EDIT_EVENT, {
        detail: { pos, attrs: node.attrs as MentionAttrs },
        bubbles: true,
      }),
    );
  };

  return (
    <NodeViewWrapper
      onClick={isEditablePrompt ? handleClick : undefined}
      className={cn(
        "px-1 py-1 rounded",
        "inline-flex items-center gap-1",
        isEditablePrompt
          ? "cursor-pointer hover:ring-2 hover:ring-amber-300 dark:hover:ring-amber-600"
          : "cursor-default",
        "select-none",
        "text-xs font-light",
        isAgent
          ? "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400"
          : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
        isSelected && "outline-2 outline-blue-300 outline-offset-0",
        "capitalize",
      )}
    >
      {char}
      {name ? toTitleCase(name) : ""}
    </NodeViewWrapper>
  );
}

// ============================================================================
// Extension
// ============================================================================

export const MentionNode = Node.create({
  name: "mention",

  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-id") || null,
        renderHTML: (attributes) => {
          if (!attributes.id) return {};
          return { "data-id": attributes.id };
        },
      },
      name: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-name") || null,
        renderHTML: (attributes) => {
          if (!attributes.name) return {};
          return { "data-name": attributes.name };
        },
      },
      char: {
        default: "/",
        parseHTML: (element) => element.getAttribute("data-char") || "/",
        renderHTML: (attributes) => {
          if (!attributes.char) return {};
          return { "data-char": attributes.char };
        },
      },
      metadata: {
        default: null,
        parseHTML: (element) => {
          try {
            return JSON.parse(element.getAttribute("data-metadata") || "null");
          } catch {
            return null;
          }
        },
        renderHTML: (attributes) => {
          if (!attributes.metadata) return {};
          return { "data-metadata": JSON.stringify(attributes.metadata) };
        },
      },
      values: {
        default: null,
        parseHTML: (element) => {
          try {
            return JSON.parse(element.getAttribute("data-values") || "null");
          } catch {
            return null;
          }
        },
        renderHTML: (attributes) => {
          if (!attributes.values) return {};
          return { "data-values": JSON.stringify(attributes.values) };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="mention"]',
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    // Required by ProseMirror (maps to toDOM)
    // React component handles actual visual rendering
    const attrs: Record<string, string> = {
      "data-type": "mention",
    };

    if (node.attrs.id) {
      attrs["data-id"] = node.attrs.id;
    }
    if (node.attrs.name) {
      attrs["data-name"] = node.attrs.name;
    }
    if (node.attrs.char) {
      attrs["data-char"] = node.attrs.char;
    }
    if (node.attrs.metadata) {
      attrs["data-metadata"] = JSON.stringify(node.attrs.metadata);
    }
    if (node.attrs.values) {
      attrs["data-values"] = JSON.stringify(node.attrs.values);
    }

    return ["span", { ...HTMLAttributes, ...attrs }];
  },

  renderText({ node }) {
    const char = node.attrs.char ?? "@";
    const name = node.attrs.name ?? "";
    return `${char}${name}`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionNodeView);
  },
});

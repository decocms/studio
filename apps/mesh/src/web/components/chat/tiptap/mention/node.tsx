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
  /** Discriminator for "/" mentions; "@" mentions are always agents. */
  kind?: "prompt" | "resource";
  /** Argument values the user typed in PromptArgsDialog. Only meaningful for prompt mentions. */
  args?: Record<string, string>;
}

// ============================================================================
// Edit Bridge (chip click → SlashMention dialog)
// ============================================================================

export interface EditMentionRequest {
  promptId: string;
  promptName: string;
  args: Record<string, string>;
  pos: number;
}

export interface MentionStorage {
  onEditChip: ((req: EditMentionRequest) => void) | null;
}

export function getMentionStorage(editor: Editor): MentionStorage | undefined {
  return (editor.storage as unknown as Record<string, unknown>).mention as
    | MentionStorage
    | undefined;
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

function MentionNodeView(props: NodeViewProps) {
  const { node, selected, view, editor, getPos } = props;
  const { name, char, kind, id, args } = node.attrs as MentionAttrs;

  const isSelected = selected && view.editable;
  const isAgent = char === "@";
  // Clickable when editable AND it's a "/" mention that's either a known
  // prompt or a legacy chip without `kind` (we'll re-verify in the handler).
  const isClickable = view.editable && char === "/" && kind !== "resource";

  const handleClick = (e: React.MouseEvent) => {
    if (!isClickable) return;
    const storage = getMentionStorage(editor);
    const onEdit = storage?.onEditChip;
    if (!onEdit) return;
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    e.preventDefault();
    e.stopPropagation();
    onEdit({
      promptId: id,
      promptName: name,
      args: args ?? {},
      pos,
    });
  };

  return (
    <NodeViewWrapper
      onClick={handleClick}
      className={cn(
        "px-1 py-1 rounded",
        "inline-flex items-center gap-1",
        isClickable ? "cursor-pointer" : "cursor-default",
        "select-none",
        "text-xs font-light",
        isAgent
          ? "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400"
          : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
        isSelected && "outline-2 outline-blue-300 outline-offset-0",
        isClickable && "hover:brightness-95",
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

  addStorage(): MentionStorage {
    return {
      onEditChip: null,
    };
  },

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
      kind: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-kind") || null,
        renderHTML: (attributes) => {
          if (!attributes.kind) return {};
          return { "data-kind": attributes.kind };
        },
      },
      args: {
        default: null,
        parseHTML: (element) => {
          try {
            return JSON.parse(element.getAttribute("data-args") || "null");
          } catch {
            return null;
          }
        },
        renderHTML: (attributes) => {
          if (!attributes.args) return {};
          return { "data-args": JSON.stringify(attributes.args) };
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
    if (node.attrs.kind) {
      attrs["data-kind"] = node.attrs.kind;
    }
    if (node.attrs.args) {
      attrs["data-args"] = JSON.stringify(node.attrs.args);
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

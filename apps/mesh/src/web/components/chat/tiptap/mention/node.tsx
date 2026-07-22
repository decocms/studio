import { toTitleCase } from "@/web/components/chat/message/parts/tool-call-part/utils.tsx";
import { useT } from "@/web/i18n/use-t.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import { JSONContent, mergeAttributes, Node } from "@tiptap/core";
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
  /** Discriminator for "/" mentions ("@" mentions are agents), plus "task" for
   * a task-board reference chip (char "@", metadata carries title/description). */
  kind?: "prompt" | "resource" | "skill" | "task";
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

declare module "@tiptap/core" {
  interface Storage {
    mention: MentionStorage;
  }
}

export function getMentionStorage(editor: Editor): MentionStorage | undefined {
  return editor.storage.mention;
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

/**
 * Confirms a mention chip with the given id still exists at `pos`. The
 * edit dialog captures `pos` at click time and only resolves later (after an
 * async prompt fetch) — if the doc changed in the meantime (chip deleted, or
 * text inserted/removed before it), `pos` may no longer point at that node.
 * `setNodeSelection` on such a stale/empty position throws (ProseMirror's
 * NodeSelection reads `.nodeSize` off a null `nodeAfter`), crashing the editor.
 */
export function isMentionNodeAt(
  editor: Editor,
  pos: number,
  id: string,
): boolean {
  const node = editor.state.doc.nodeAt(pos);
  return node?.type.name === "mention" && node.attrs.id === id;
}

// ============================================================================
// React Node View Component
// ============================================================================

function MentionNodeView(props: NodeViewProps) {
  const { node, selected, view, editor, getPos } = props;
  const { name, char, kind, id, args } = node.attrs as MentionAttrs;
  const t = useT();

  const isSelected = selected && view.editable;
  const isTask = kind === "task";
  const isAgent = char === "@";
  // Clickable when editable AND it's a "/" mention that's either a known
  // prompt or a legacy chip without `kind` (we'll re-verify in the handler).
  // Resources and skills have no edit dialog — their chip is inert.
  const isClickable =
    view.editable && char === "/" && (kind === "prompt" || kind == null);

  const triggerEdit = () => {
    const storage = getMentionStorage(editor);
    const onEdit = storage?.onEditChip;
    if (!onEdit) return;
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    onEdit({
      promptId: id,
      promptName: name,
      args: args ?? {},
      pos,
    });
  };

  const handleClick = (e: React.MouseEvent) => {
    if (!isClickable) return;
    e.preventDefault();
    e.stopPropagation();
    triggerEdit();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isClickable) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    triggerEdit();
  };

  return (
    <NodeViewWrapper
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      aria-label={
        isClickable
          ? t("chat.mention.editPrompt", {
              name: name ? toTitleCase(name) : "",
            })
          : undefined
      }
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
        // Task titles are full sentences — render them verbatim (no title-case)
        // and clamp the width so a long title stays a compact chip.
        !isTask && "capitalize",
      )}
    >
      {char}
      {isTask ? (
        <span className="inline-block max-w-[220px] truncate align-bottom">
          {name ?? ""}
        </span>
      ) : name ? (
        toTitleCase(name)
      ) : (
        ""
      )}
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

  renderHTML({ HTMLAttributes }) {
    // React component handles actual visual rendering; this only satisfies
    // ProseMirror's toDOM requirement. HTMLAttributes already carries every
    // data-* entry from each attribute's own renderHTML (see addAttributes above).
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-type": "mention" }),
    ];
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

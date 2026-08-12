import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { JSONContent, Node } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type Editor,
  type NodeViewProps,
  type Range,
} from "@tiptap/react";

// ============================================================================
// File Attributes
// ============================================================================

export interface FileAttrs {
  /** Unique identifier for the file */
  id: string;
  /** File name */
  name: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Base64 encoded file data */
  data: string;
}

// ============================================================================
// Insert File Helper
// ============================================================================

/**
 * Inserts a file node into the editor at the specified range.
 * @param editor - The Tiptap editor instance
 * @param range - The range where the file should be inserted
 * @param attrs - The file attributes
 */
export function insertFile(
  editor: Editor,
  range: Range,
  attrs: FileAttrs,
): void {
  editor
    .chain()
    .focus()
    .insertContentAt(range, [createFileDoc(attrs), { type: "text", text: " " }])
    .run();
}

function createFileDoc(attrs: FileAttrs): JSONContent {
  return {
    type: "file",
    attrs: attrs satisfies FileAttrs,
  };
}

// ============================================================================
// React Node View Component
// ============================================================================

function FileNodeView(props: NodeViewProps) {
  const { node, selected, view } = props;
  const { name, mimeType, data } = node.attrs as FileAttrs;

  const isSelected = selected && view.editable;
  const isImage = mimeType.startsWith("image/");

  return (
    <NodeViewWrapper
      className={cn(
        "px-1 py-1 rounded",
        "inline-flex items-center gap-1",
        "cursor-default select-none",
        "text-xs font-light",
        "bg-muted text-muted-foreground",
        isSelected && "outline-2 outline-blue-300 outline-offset-0",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span>{name}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm p-1.5">
          {isImage ? (
            <img
              src={`data:${mimeType};base64,${data}`}
              alt={name}
              className="max-w-full max-h-64 object-contain rounded"
            />
          ) : (
            <div className="text-xs">
              <div className="font-medium">{name}</div>
              <div className="text-muted-foreground mt-1">{mimeType}</div>
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </NodeViewWrapper>
  );
}

// ============================================================================
// Extension
// ============================================================================

export const FileNode = Node.create({
  name: "file",

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
      mimeType: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-mime-type") || null,
        renderHTML: (attributes) => {
          if (!attributes.mimeType) return {};
          return { "data-mime-type": attributes.mimeType };
        },
      },
      size: {
        default: 0,
        parseHTML: (element) => {
          const size = element.getAttribute("data-size");
          return size ? Number.parseInt(size, 10) : 0;
        },
        renderHTML: (attributes) => {
          if (!attributes.size) return {};
          return { "data-size": String(attributes.size) };
        },
      },
      data: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-data") || null,
        renderHTML: (attributes) => {
          if (!attributes.data) return {};
          return { "data-data": attributes.data };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="file"]',
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    // Required by ProseMirror (maps to toDOM)
    // React component handles actual visual rendering
    const attrs: Record<string, string> = {
      "data-type": "file",
    };

    if (node.attrs.id) {
      attrs["data-id"] = node.attrs.id;
    }
    if (node.attrs.name) {
      attrs["data-name"] = node.attrs.name;
    }
    if (node.attrs.mimeType) {
      attrs["data-mime-type"] = node.attrs.mimeType;
    }
    if (node.attrs.size) {
      attrs["data-size"] = String(node.attrs.size);
    }
    if (node.attrs.data) {
      attrs["data-data"] = node.attrs.data;
    }

    return ["span", { ...HTMLAttributes, ...attrs }];
  },

  renderText({ node }) {
    const name = node.attrs.name ?? "";
    return `[${name}]`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileNodeView);
  },
});

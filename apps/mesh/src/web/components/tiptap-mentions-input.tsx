import {
  useEditor,
  EditorContent,
  ReactRenderer,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type Editor,
  type Content,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import { cn } from "@deco/ui/lib/utils.ts";
import { createStore } from "zustand";
import { useStore } from "zustand";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@deco/ui/components/hover-card.tsx";
import { createContext, useContext } from "react";

// --- Types ---

export interface MentionItem {
  id: string;
  label: string;
  children?: MentionItem[];
}

// --- Resolved Refs Context ---

const ResolvedRefsContext = createContext<Record<string, unknown> | undefined>(
  undefined,
);

/**
 * Resolve a reference like "Step_1.field.subfield" from the resolved refs map
 */
function resolveRefPath(
  resolvedRefs: Record<string, unknown>,
  refId: string,
): unknown {
  const parts = refId.split(".");
  const rootKey = parts[0];
  if (!rootKey) return undefined;

  let value: unknown = resolvedRefs[rootKey];

  for (let i = 1; i < parts.length && value !== undefined; i++) {
    const part = parts[i];
    if (!part) continue;
    if (typeof value === "object" && value !== null) {
      value = (value as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return value;
}

/**
 * Custom NodeView for mentions that shows resolved values on hover
 */
function MentionNodeView({
  node,
}: {
  node: { attrs: Record<string, unknown> };
}) {
  const resolvedRefs = useContext(ResolvedRefsContext);
  const mentionId = (node.attrs.id as string) ?? "";

  const hasResolvedRefs = resolvedRefs !== undefined;
  const resolvedValue = hasResolvedRefs
    ? resolveRefPath(resolvedRefs, mentionId)
    : undefined;

  const formattedValue =
    resolvedValue !== undefined
      ? typeof resolvedValue === "object"
        ? JSON.stringify(resolvedValue, null, 2)
        : String(resolvedValue)
      : undefined;

  const mentionSpan = (
    <span className="bg-primary/20 text-primary px-1 rounded font-medium cursor-pointer">
      @{mentionId}
    </span>
  );

  if (!hasResolvedRefs || formattedValue === undefined) {
    return <NodeViewWrapper as="span">{mentionSpan}</NodeViewWrapper>;
  }

  return (
    <NodeViewWrapper as="span">
      <HoverCard openDelay={200}>
        <HoverCardTrigger asChild>{mentionSpan}</HoverCardTrigger>
        <HoverCardContent
          className="w-auto max-w-[400px] p-3"
          side="top"
          align="start"
        >
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">
              @{mentionId}
            </div>
            <pre className="text-xs font-mono bg-muted/50 p-2 rounded overflow-auto max-h-[200px] whitespace-pre-wrap break-all">
              {formattedValue}
            </pre>
          </div>
        </HoverCardContent>
      </HoverCard>
    </NodeViewWrapper>
  );
}

/**
 * Flatten the mentions tree into a flat array for suggestions and lookup
 */
function flattenMentions(items: MentionItem[]): MentionItem[] {
  const result: MentionItem[] = [];

  function traverse(list: MentionItem[]) {
    for (const item of list) {
      // Only add leaf nodes (no children) as selectable mentions
      if (!item.children?.length) {
        result.push(item);
      }
      if (item.children) {
        traverse(item.children);
      }
    }
  }

  traverse(items);
  return result;
}

interface MentionState {
  items: MentionItem[];
  selectedIndex: number;
  command: ((item: MentionItem) => void) | null;
}

// --- Module-level store (singleton per popup lifecycle) ---

let mentionStore = createMentionStore();

function createMentionStore() {
  return createStore<MentionState>(() => ({
    items: [],
    selectedIndex: 0,
    command: null,
  }));
}

function setItems(items: MentionItem[], command: (item: MentionItem) => void) {
  mentionStore.setState({ items, command, selectedIndex: 0 });
}

function moveUp() {
  const { items, selectedIndex } = mentionStore.getState();
  if (!items.length) return;
  mentionStore.setState({
    selectedIndex: (selectedIndex - 1 + items.length) % items.length,
  });
}

function moveDown() {
  const { items, selectedIndex } = mentionStore.getState();
  if (!items.length) return;
  mentionStore.setState({ selectedIndex: (selectedIndex + 1) % items.length });
}

function selectItem(): boolean {
  const { items, selectedIndex, command } = mentionStore.getState();
  const item = items[selectedIndex];
  if (!item) return false;
  command?.(item);
  return true;
}

function reset() {
  mentionStore = createMentionStore();
}

// --- Mention List Component ---

function MentionList() {
  const items = useStore(mentionStore, (s) => s.items);
  const selectedIndex = useStore(mentionStore, (s) => s.selectedIndex);

  if (!items.length) return null;

  return (
    <div className="bg-popover border border-border rounded-lg shadow-lg overflow-hidden min-w-[180px]">
      <div className="p-1">
        {items.map((item, index) => (
          <button
            type="button"
            key={item.id}
            onClick={() => {
              mentionStore.setState({ selectedIndex: index });
              selectItem();
            }}
            className={cn(
              "flex items-center w-full text-left px-3 py-1.5 text-sm rounded-md transition-colors",
              index === selectedIndex
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Suggestion Renderer ---

interface SuggestionProps {
  editor: Editor;
  items: MentionItem[];
  command: (item: MentionItem) => void;
  clientRect?: (() => DOMRect | null) | null;
}

function suggestionRenderer() {
  let component: ReactRenderer | null = null;
  let popup: HTMLElement | null = null;

  return {
    onStart: (props: SuggestionProps) => {
      setItems(props.items, props.command);
      component = new ReactRenderer(MentionList, { editor: props.editor });
      popup = document.createElement("div");

      popup.style.cssText = "position:absolute;z-index:9999";
      const rect = props.clientRect?.();
      if (rect) {
        popup.style.top = `${rect.bottom + window.scrollY + 4}px`;
        popup.style.left = `${rect.left + window.scrollX}px`;
      }
      popup.appendChild(component.element);
      document.body.appendChild(popup);
    },
    onUpdate: (props: SuggestionProps) => {
      setItems(props.items, props.command);
      const rect = props.clientRect?.();
      if (rect && popup) {
        popup.style.top = `${rect.bottom + window.scrollY + 4}px`;
        popup.style.left = `${rect.left + window.scrollX}px`;
      }
    },
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === "Escape") {
        popup?.remove();
        component?.destroy();
        reset();
        return true;
      }
      if (event.key === "ArrowUp") {
        moveUp();
        return true;
      }
      if (event.key === "ArrowDown") {
        moveDown();
        return true;
      }
      if (event.key === "Enter") {
        return selectItem();
      }
      return false;
    },
    onExit: () => {
      popup?.remove();
      component?.destroy();
      reset();
    },
  };
}

// --- Helper Functions ---

// Regex to match @mentions (e.g., @Initial_Step.query)
const MENTION_REGEX = /@([\w.]+)/g;

/**
 * Parse plain text value and convert @mentions into Tiptap JSON format.
 */
function parseValueToTiptapContent(
  value: string | undefined,
  mentions: MentionItem[],
): Content {
  if (!value) return null;

  const flatMentions = flattenMentions(mentions);
  const mentionMap = new Map(flatMentions.map((m) => [m.id, m]));

  // Check if there are any @mentions in the value
  const hasRefs = MENTION_REGEX.test(value);
  if (!hasRefs) return value;

  // Reset regex state
  MENTION_REGEX.lastIndex = 0;

  type NodeContent = {
    type: string;
    text?: string;
    attrs?: Record<string, string>;
  };
  const content: NodeContent[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = MENTION_REGEX.exec(value)) !== null) {
    const mentionId = match[1] ?? "";
    const matchStart = match.index;

    if (matchStart > lastIndex) {
      content.push({ type: "text", text: value.slice(lastIndex, matchStart) });
    }

    const mentionItem = mentionMap.get(mentionId);
    if (mentionItem) {
      content.push({
        type: "mention",
        attrs: { id: mentionItem.id, label: mentionItem.label },
      });
    } else {
      content.push({ type: "text", text: match[0] });
    }

    lastIndex = matchStart + match[0].length;
  }

  if (lastIndex < value.length) {
    content.push({ type: "text", text: value.slice(lastIndex) });
  }

  return {
    type: "doc",
    content: [
      { type: "paragraph", content: content.length > 0 ? content : undefined },
    ],
  };
}

// --- Component ---

interface MentionInputProps {
  mentions: MentionItem[];
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
  readOnly?: boolean;
  /**
   * Map of resolved ref values for displaying on hover.
   * Keys are root step names (e.g., "Step_1", "input").
   * When provided, hovering mentions will show their resolved values.
   */
  resolvedRefs?: Record<string, unknown>;
}

export function MentionInput({
  mentions,
  value,
  onChange,
  placeholder,
  className,
  readOnly,
  resolvedRefs,
}: MentionInputProps) {
  const parsedContent = parseValueToTiptapContent(value, mentions);

  // Use custom NodeView when we have resolvedRefs to enable hover tooltips
  const useCustomNodeView = resolvedRefs !== undefined;

  const editor = useEditor({
    content: parsedContent,
    editable: !readOnly,
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        hardBreak: false,
      }),
      Mention.configure({
        HTMLAttributes: {
          class: "bg-primary/20 text-primary px-1 rounded font-medium",
        },
        renderText: ({ node }) => `@${node.attrs.id}`,
        renderHTML: ({ options, node }) => [
          "span",
          options.HTMLAttributes,
          `@${node.attrs.id}`,
        ],
        suggestion: {
          items: ({ query }: { query: string }) => {
            const flat = flattenMentions(mentions);
            return flat.filter(
              (m) =>
                m.label.toLowerCase().includes(query.toLowerCase()) ||
                m.id.toLowerCase().includes(query.toLowerCase()),
            );
          },
          render: suggestionRenderer,
          command: ({ editor, range, props }) => {
            editor
              .chain()
              .focus()
              .insertContentAt(range, [{ type: "mention", attrs: props }])
              .run();
          },
        },
      }).extend(
        useCustomNodeView
          ? {
              addNodeView() {
                return ReactNodeViewRenderer(MentionNodeView);
              },
            }
          : {},
      ),
    ],
    editorProps: {
      attributes: {
        class:
          "prose prose-sm max-w-none focus:outline-none w-full min-h-[20px]",
        "data-placeholder": placeholder ?? "",
      },
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => onChange?.(editor.getText().trim()),
  });

  const content = (
    <div
      className={cn(
        "rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
        className,
      )}
    >
      <EditorContent editor={editor} />
    </div>
  );

  // Wrap with context provider if we have resolved refs
  if (resolvedRefs !== undefined) {
    return (
      <ResolvedRefsContext.Provider value={resolvedRefs}>
        {content}
      </ResolvedRefsContext.Provider>
    );
  }

  return content;
}

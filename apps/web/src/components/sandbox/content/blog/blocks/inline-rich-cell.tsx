import { useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { cn } from "@decocms/ui/lib/utils.ts";
import { EDITOR_LINK_CLASS } from "@/components/sections-editor/editor-classes";
import { toInlineHtml } from "@/components/sections-editor/inline-html";
import type { LinkSource } from "@/components/sections-editor/rich-text-link-control";
import { InlineMarksToolbar } from "./marks-toolbar";

/** Placeholder only sets `data-placeholder`; no global ProseMirror stylesheet renders it. */
const PLACEHOLDER_CLASS = [
  "[&_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
  "[&_p.is-editor-empty:first-child::before]:text-muted-foreground/40",
  "[&_p.is-editor-empty:first-child::before]:float-left",
  "[&_p.is-editor-empty:first-child::before]:h-0",
  "[&_p.is-editor-empty:first-child::before]:pointer-events-none",
].join(" ");

/**
 * A single cell of inline rich text, stored as inline HTML with no block
 * structure of its own — the Table block's `string[][]` has nowhere to put a
 * paragraph, hence `toInlineHtml` and the swallowed Enter. Uncontrolled after
 * mount: callers that restructure their data must remount the cell.
 */
export function InlineRichCell({
  value,
  onChange,
  placeholder,
  className,
  menuHost,
  sources,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Extra link targets (a post, a product) — see {@link InlineMarksToolbar}. */
  sources?: LinkSource[];
  /** Shared mount point for the marks menu — see {@link InlineMarksToolbar}. */
  menuHost?: HTMLElement | null;
}) {
  // Reachable from onUpdate without recreating the editor (resets selection).
  const onChangeRef = useRef(onChange);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read only inside the onUpdate callback, never during render
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Cleared so each link's own `target` decides same-tab vs new-tab.
        link: { HTMLAttributes: {} },
        // A cell is inline-only: every block structure is its own deco block.
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        dropcursor: false,
        gapcursor: false,
      }),
      ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
    ],
    content: value || "",
    editorProps: {
      attributes: {
        class: cn(
          "focus:outline-none",
          EDITOR_LINK_CLASS,
          PLACEHOLDER_CLASS,
          className,
        ),
      },
      // A cell is one line — a second paragraph has nowhere to go in storage.
      handleKeyDown: (_view, event) => event.key === "Enter",
    },
    onUpdate: ({ editor }) =>
      onChangeRef.current(toInlineHtml(editor.getHTML())),
  });

  if (!editor) return null;

  return (
    <div className="relative">
      <InlineMarksToolbar
        editor={editor}
        appendTo={menuHost ?? undefined}
        sources={sources}
      />
      <EditorContent editor={editor} />
    </div>
  );
}

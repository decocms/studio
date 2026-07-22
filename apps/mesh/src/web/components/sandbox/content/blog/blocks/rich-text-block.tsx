import { useRef, useState } from "react";
import { Bold01, Italic01, Underline01 } from "@untitledui/icons";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { cn } from "@deco/ui/lib/utils.js";
import {
  RichTextLinkControl,
  ToolbarButton,
} from "@/web/components/sections-editor/rich-text-link-control";

/**
 * Inline rich-text editor for Paragraph blocks. Renders the paragraph as
 * formatted text (not a form field) and edits it in place — select text to
 * bold/italic/underline/link via the toolbar that appears while focused.
 * Stores the block's `html` field.
 */
export function RichTextBlock({
  html,
  placeholder,
  onChange,
}: {
  html: string;
  placeholder?: string;
  onChange: (html: string) => void;
}) {
  // Keep the latest onChange reachable from TipTap's onUpdate without
  // recreating the editor (which would reset selection/undo on every keystroke).
  const onChangeRef = useRef(onChange);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read only inside the onUpdate callback, never during render
  onChangeRef.current = onChange;

  const [linkOpen, setLinkOpen] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Clear the link extension's default target/rel so each link's own
        // `target` attribute controls same-tab vs new-tab (see link control).
        link: { HTMLAttributes: {} },
        // Paragraph blocks are inline-only: structural blocks are their own
        // deco blocks, so disable the block-level marks here.
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
      Placeholder.configure({ placeholder: placeholder ?? "Write something…" }),
    ],
    content: html || "",
    editorProps: {
      attributes: {
        class: cn(
          "prose prose-sm dark:prose-invert max-w-none focus:outline-none",
          "leading-relaxed [&_p]:my-0",
        ),
      },
    },
    onUpdate: ({ editor }) => {
      const next = editor.getHTML();
      // TipTap emits "<p></p>" for empty content — normalize to "".
      onChangeRef.current(next === "<p></p>" ? "" : next);
    },
  });

  // TipTap v3 no longer re-renders on transactions by default, so focus and
  // mark state must be selected reactively — reading `editor.isFocused`
  // during render goes stale (the toolbar never appeared on mouse selection).
  const marks = useEditorState({
    editor,
    selector: ({ editor }) => ({
      isFocused: editor?.isFocused ?? false,
      bold: editor?.isActive("bold") ?? false,
      italic: editor?.isActive("italic") ?? false,
      underline: editor?.isActive("underline") ?? false,
      link: editor?.isActive("link") ?? false,
    }),
  });

  if (!editor) return null;

  return (
    <div className="relative">
      {(marks.isFocused || linkOpen) && (
        <div className="absolute -top-9 left-0 z-10 flex items-center gap-0.5 rounded-md border bg-popover p-0.5 shadow-md">
          <ToolbarButton
            active={marks.bold}
            label="Bold"
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold01 size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={marks.italic}
            label="Italic"
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic01 size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={marks.underline}
            label="Underline"
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            <Underline01 size={14} />
          </ToolbarButton>
          <RichTextLinkControl
            editor={editor}
            active={marks.link}
            open={linkOpen}
            onOpenChange={setLinkOpen}
          />
        </div>
      )}
      <EditorContent editor={editor} className="text-[15px] text-foreground" />
    </div>
  );
}

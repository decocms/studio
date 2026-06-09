import { useRef } from "react";
import { Bold01, Italic01, Link01, Underline01 } from "@untitledui/icons";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { cn } from "@deco/ui/lib/utils.js";

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

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
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

  if (!editor) return null;

  return (
    <div className="relative">
      {editor.isFocused && (
        <div className="absolute -top-9 left-0 z-10 flex items-center gap-0.5 rounded-md border bg-popover p-0.5 shadow-md">
          <MarkButton
            active={editor.isActive("bold")}
            label="Bold"
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold01 size={14} />
          </MarkButton>
          <MarkButton
            active={editor.isActive("italic")}
            label="Italic"
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic01 size={14} />
          </MarkButton>
          <MarkButton
            active={editor.isActive("underline")}
            label="Underline"
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            <Underline01 size={14} />
          </MarkButton>
          <MarkButton
            active={editor.isActive("link")}
            label="Link"
            onClick={() => {
              const prev = editor.getAttributes("link").href as
                | string
                | undefined;
              const url = window.prompt("Link URL", prev ?? "https://");
              if (url === null) return;
              if (url === "") {
                editor.chain().focus().unsetLink().run();
              } else {
                editor.chain().focus().setLink({ href: url }).run();
              }
            }}
          >
            <Link01 size={14} />
          </MarkButton>
        </div>
      )}
      <EditorContent editor={editor} className="text-[15px] text-foreground" />
    </div>
  );
}

function MarkButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      // Keep the editor selection while clicking the toolbar.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded transition-colors cursor-pointer",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

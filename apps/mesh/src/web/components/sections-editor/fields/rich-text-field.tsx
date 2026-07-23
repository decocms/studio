import { useRef, useState } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold01,
  Heading01,
  Heading02,
  Italic01,
  List,
  Strikethrough01,
  Underline01,
} from "@untitledui/icons";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import { Label } from "@deco/ui/components/label.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import type { FieldProps } from "./field-props";
import { RichTextLinkControl, ToolbarButton } from "../rich-text-link-control";

export function RichTextField({
  schema,
  value,
  onChange,
  path,
  label,
}: FieldProps) {
  const strValue = typeof value === "string" ? value : "";

  const onChangeRef = useRef(onChange);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read only inside the onUpdate callback, never during render
  onChangeRef.current = onChange;

  const [linkOpen, setLinkOpen] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // Clear the extension's default target/rel so each link's own
        // `target` attribute controls same-tab vs new-tab (see link control).
        link: { HTMLAttributes: {} },
      }),
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
    ],
    content: strValue || "",
    editorProps: {
      attributes: {
        class: cn(
          "prose prose-sm dark:prose-invert max-w-none focus:outline-none",
          "min-h-[80px] px-3 py-2",
        ),
      },
    },
    onUpdate: ({ editor }) => {
      const next = editor.getHTML();
      onChangeRef.current(next === "<p></p>" ? "" : next);
    },
  });

  // TipTap v3 no longer re-renders on transactions by default — active mark
  // state must be selected reactively or the toolbar highlights go stale.
  const marks = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive("bold") ?? false,
      italic: editor?.isActive("italic") ?? false,
      underline: editor?.isActive("underline") ?? false,
      strike: editor?.isActive("strike") ?? false,
      h1: editor?.isActive("heading", { level: 1 }) ?? false,
      h2: editor?.isActive("heading", { level: 2 }) ?? false,
      bulletList: editor?.isActive("bulletList") ?? false,
      orderedList: editor?.isActive("orderedList") ?? false,
      link: editor?.isActive("link") ?? false,
      alignLeft: editor?.isActive({ textAlign: "left" }) ?? false,
      alignCenter: editor?.isActive({ textAlign: "center" }) ?? false,
      alignRight: editor?.isActive({ textAlign: "right" }) ?? false,
      alignJustify: editor?.isActive({ textAlign: "justify" }) ?? false,
    }),
  });

  if (!editor) return null;

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <Label htmlFor={path}>{label}</Label>
        {schema.description && (
          <p className="text-xs leading-normal text-muted-foreground">
            {schema.description}
          </p>
        )}
      </div>
      <div className="overflow-hidden rounded-md border border-input">
        <div className="flex flex-wrap items-center gap-0.5 border-b border-border/60 bg-muted/30 px-1.5 py-1">
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
          <ToolbarButton
            active={marks.strike}
            label="Strikethrough"
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <Strikethrough01 size={14} />
          </ToolbarButton>

          <div className="mx-0.5 h-4 w-px bg-border" />

          <ToolbarButton
            active={marks.h1}
            label="Heading 1"
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 1 }).run()
            }
          >
            <Heading01 size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={marks.h2}
            label="Heading 2"
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
          >
            <Heading02 size={14} />
          </ToolbarButton>

          <div className="mx-0.5 h-4 w-px bg-border" />

          <ToolbarButton
            active={marks.bulletList}
            label="Bullet list"
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={marks.orderedList}
            label="Ordered list"
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <span className="text-[11px] font-semibold leading-none">1.</span>
          </ToolbarButton>

          <div className="mx-0.5 h-4 w-px bg-border" />

          <RichTextLinkControl
            editor={editor}
            active={marks.link}
            open={linkOpen}
            onOpenChange={setLinkOpen}
          />

          <div className="mx-0.5 h-4 w-px bg-border" />

          <ToolbarButton
            active={marks.alignLeft}
            label="Align left"
            onClick={() => editor.chain().focus().setTextAlign("left").run()}
          >
            <AlignLeft size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={marks.alignCenter}
            label="Align center"
            onClick={() => editor.chain().focus().setTextAlign("center").run()}
          >
            <AlignCenter size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={marks.alignRight}
            label="Align right"
            onClick={() => editor.chain().focus().setTextAlign("right").run()}
          >
            <AlignRight size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={marks.alignJustify}
            label="Justify"
            onClick={() => editor.chain().focus().setTextAlign("justify").run()}
          >
            <AlignJustify size={14} />
          </ToolbarButton>
        </div>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

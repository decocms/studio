import { useRef } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold01,
  Heading01,
  Heading02,
  Italic01,
  Link01,
  List,
  Strikethrough01,
  Underline01,
} from "@untitledui/icons";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import { Label } from "@deco/ui/components/label.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import type { FieldProps } from "./field-props";
import { isSafeLinkUrl } from "../rich-text-link-validation";

function ToolbarButton({
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

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
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
            active={editor.isActive("bold")}
            label="Bold"
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold01 size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("italic")}
            label="Italic"
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic01 size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("underline")}
            label="Underline"
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            <Underline01 size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("strike")}
            label="Strikethrough"
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <Strikethrough01 size={14} />
          </ToolbarButton>

          <div className="mx-0.5 h-4 w-px bg-border" />

          <ToolbarButton
            active={editor.isActive("heading", { level: 1 })}
            label="Heading 1"
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 1 }).run()
            }
          >
            <Heading01 size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("heading", { level: 2 })}
            label="Heading 2"
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
          >
            <Heading02 size={14} />
          </ToolbarButton>

          <div className="mx-0.5 h-4 w-px bg-border" />

          <ToolbarButton
            active={editor.isActive("bulletList")}
            label="Bullet list"
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("orderedList")}
            label="Ordered list"
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <span className="text-[11px] font-semibold leading-none">1.</span>
          </ToolbarButton>

          <div className="mx-0.5 h-4 w-px bg-border" />

          <ToolbarButton
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
              } else if (isSafeLinkUrl(url)) {
                editor.chain().focus().setLink({ href: url }).run();
              }
            }}
          >
            <Link01 size={14} />
          </ToolbarButton>

          <div className="mx-0.5 h-4 w-px bg-border" />

          <ToolbarButton
            active={editor.isActive({ textAlign: "left" })}
            label="Align left"
            onClick={() => editor.chain().focus().setTextAlign("left").run()}
          >
            <AlignLeft size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive({ textAlign: "center" })}
            label="Align center"
            onClick={() => editor.chain().focus().setTextAlign("center").run()}
          >
            <AlignCenter size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive({ textAlign: "right" })}
            label="Align right"
            onClick={() => editor.chain().focus().setTextAlign("right").run()}
          >
            <AlignRight size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive({ textAlign: "justify" })}
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

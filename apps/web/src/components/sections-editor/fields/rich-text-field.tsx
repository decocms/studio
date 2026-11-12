import { useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { FieldProps } from "./field-props";
import { FieldLabel } from "./field-label";
import { RichTextToolbar } from "../rich-text-toolbar";
import { EDITOR_LINK_CLASS } from "../editor-classes";
import { toInlineHtml } from "../inline-html";

export function RichTextField({
  schema,
  value,
  onChange,
  path,
  label,
  sandbox,
  inline = false,
}: FieldProps & {
  /**
   * When true (the `rich-text-inline` format), the value is serialized without
   * a block wrapper and the block-structure controls (heading/list/align) are
   * hidden — those don't survive unwrapping and produce no legal inline HTML.
   */
  inline?: boolean;
}) {
  const strValue = typeof value === "string" ? value : "";

  const onChangeRef = useRef(onChange);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read only inside the onUpdate callback, never during render
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Inline fields can't carry block structure — it wouldn't survive the
        // unwrap in toInlineHtml — so disable headings/lists/blockquote there.
        heading: inline ? false : { levels: [1, 2, 3, 4, 5, 6] },
        bulletList: inline ? false : undefined,
        orderedList: inline ? false : undefined,
        listItem: inline ? false : undefined,
        blockquote: inline ? false : undefined,
        // Clear the extension's default target/rel so each link's own
        // `target` attribute controls same-tab vs new-tab (see link control).
        link: { HTMLAttributes: {} },
      }),
      // Text alignment is a block attribute; meaningless once unwrapped inline.
      ...(inline
        ? []
        : [TextAlign.configure({ types: ["heading", "paragraph"] })]),
      // FontSize and Color both store their value on the textStyle mark, so
      // TextStyle is required alongside them.
      TextStyle,
      FontSize,
      Color,
    ],
    content: strValue || "",
    editorProps: {
      attributes: {
        class: cn(
          "prose prose-sm dark:prose-invert max-w-none focus:outline-none",
          "min-h-[80px] px-3 py-2",
          EDITOR_LINK_CLASS,
        ),
      },
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      const next = inline ? toInlineHtml(html) : html;
      onChangeRef.current(next === "<p></p>" || next === "" ? "" : next);
    },
  });

  if (!editor) return null;

  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor={path}
        label={label}
        description={schema.description}
        virtualMcpId={sandbox?.virtualMcpId}
      />
      <div className="overflow-hidden rounded-[var(--studio-surface-radius,var(--radius-md))] border shadow-edge border-input">
        <RichTextToolbar editor={editor} inline={inline} />
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

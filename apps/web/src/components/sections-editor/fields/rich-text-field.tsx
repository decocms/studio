import { useRef, useState } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold01,
  Italic01,
  List,
  Minus,
  Plus,
  Strikethrough01,
  Underline01,
} from "@untitledui/icons";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { useT } from "@/i18n/use-t.ts";
import type { FieldProps } from "./field-props";
import { FieldLabel } from "./field-label";
import { RichTextColorControl } from "../rich-text-color-control";
import { RichTextLinkControl, ToolbarButton } from "../rich-text-link-control";

/** Heading levels the editor supports, in dropdown order. */
const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

/**
 * Serialize the editor's HTML without a block wrapper, for `rich-text-inline`
 * fields whose value gets injected where a `<p>`/`<div>` can't legally nest
 * (inside another `<p>`, a phrasing-only context, etc.). ProseMirror always
 * keeps a top-level block internally, so we unwrap it on output: a single
 * block returns its inline contents; multiple blocks join with `<br>`. This
 * round-trips — TipTap re-wraps the inline HTML in a paragraph on load.
 */
function toInlineHtml(html: string): string {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const blocks = Array.from(body.children);
  if (blocks.length === 0) return body.innerHTML;
  return blocks.map((block) => block.innerHTML).join("<br>");
}

/** Font-size stepper bounds (px). Default is the prose base when unset. */
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 128;
const FONT_SIZE_DEFAULT = 16;
const FONT_SIZE_STEP = 1;

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
  const t = useT();
  const strValue = typeof value === "string" ? value : "";

  const onChangeRef = useRef(onChange);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read only inside the onUpdate callback, never during render
  onChangeRef.current = onChange;

  const [linkOpen, setLinkOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Inline fields can't carry block structure — it wouldn't survive the
        // unwrap in toInlineHtml — so disable headings/lists/blockquote there.
        heading: inline ? false : { levels: [...HEADING_LEVELS] },
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
        ),
      },
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      const next = inline ? toInlineHtml(html) : html;
      onChangeRef.current(next === "<p></p>" || next === "" ? "" : next);
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
      // 0 = paragraph (no heading active), otherwise the active heading level.
      headingLevel:
        HEADING_LEVELS.find(
          (level) => editor?.isActive("heading", { level }) ?? false,
        ) ?? 0,
      // px string (e.g. "18px") when a size is set on the selection, else null.
      fontSize: (editor?.getAttributes("textStyle").fontSize as string) ?? null,
      // hex string (e.g. "#e11d48") when a color is set, else null.
      color: (editor?.getAttributes("textStyle").color as string) ?? null,
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

  const styleValue =
    marks.headingLevel > 0 ? `h${marks.headingLevel}` : "paragraph";
  const applyStyle = (next: string) => {
    const chain = editor.chain().focus();
    if (next === "paragraph") {
      chain.setParagraph().run();
      return;
    }
    const level = HEADING_LEVELS.find((l) => `h${l}` === next);
    if (level) chain.setHeading({ level }).run();
  };

  const parsedFontSize = marks.fontSize ? parseInt(marks.fontSize, 10) : NaN;
  const currentFontSize = Number.isFinite(parsedFontSize)
    ? parsedFontSize
    : FONT_SIZE_DEFAULT;
  const applyFontSize = (px: number) => {
    const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, px));
    editor.chain().focus().setFontSize(`${clamped}px`).run();
  };

  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor={path}
        label={label}
        description={schema.description}
        virtualMcpId={sandbox?.virtualMcpId}
      />
      <div className="overflow-hidden rounded-md border border-input">
        <div className="flex flex-wrap items-center gap-0.5 border-b border-border/60 bg-muted/30 px-1.5 py-1">
          <ToolbarButton
            active={marks.bold}
            label={t("sectionsEditor.richTextField.bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold01 size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={marks.italic}
            label={t("sectionsEditor.richTextField.italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic01 size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={marks.underline}
            label={t("sectionsEditor.richTextField.underline")}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            <Underline01 size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={marks.strike}
            label={t("sectionsEditor.richTextField.strikethrough")}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <Strikethrough01 size={14} />
          </ToolbarButton>

          {!inline && (
            <>
              <div className="mx-0.5 h-4 w-px bg-border" />

              <Select value={styleValue} onValueChange={applyStyle}>
                <SelectTrigger
                  size="sm"
                  aria-label={t("sectionsEditor.richTextField.styleLabel")}
                  // Keep the editor selection while opening the dropdown.
                  onMouseDown={(e) => e.preventDefault()}
                  // Flatten the design-system trigger so it blends with the
                  // ghost-style toolbar instead of reading as a raised card.
                  className="w-[116px] gap-1 bg-transparent px-2 text-muted-foreground shadow-none! hover:bg-muted hover:text-foreground"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="paragraph">
                    {t("sectionsEditor.richTextField.styleParagraph")}
                  </SelectItem>
                  {HEADING_LEVELS.map((level) => (
                    <SelectItem key={level} value={`h${level}`}>
                      {t("sectionsEditor.richTextField.styleHeading", {
                        level,
                      })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}

          <div className="mx-0.5 h-4 w-px bg-border" />

          <div className="flex items-center gap-0.5">
            <ToolbarButton
              active={false}
              label={t("sectionsEditor.richTextField.fontSizeDecrease")}
              onClick={() => applyFontSize(currentFontSize - FONT_SIZE_STEP)}
            >
              <Minus size={14} />
            </ToolbarButton>
            <span className="min-w-[2ch] text-center text-xs tabular-nums text-muted-foreground">
              {currentFontSize}
            </span>
            <ToolbarButton
              active={false}
              label={t("sectionsEditor.richTextField.fontSizeIncrease")}
              onClick={() => applyFontSize(currentFontSize + FONT_SIZE_STEP)}
            >
              <Plus size={14} />
            </ToolbarButton>
          </div>

          <div className="mx-0.5 h-4 w-px bg-border" />

          <RichTextColorControl
            editor={editor}
            currentColor={marks.color}
            open={colorOpen}
            onOpenChange={setColorOpen}
          />

          {!inline && (
            <>
              <div className="mx-0.5 h-4 w-px bg-border" />

              <ToolbarButton
                active={marks.bulletList}
                label={t("sectionsEditor.richTextField.bulletList")}
                onClick={() => editor.chain().focus().toggleBulletList().run()}
              >
                <List size={14} />
              </ToolbarButton>
              <ToolbarButton
                active={marks.orderedList}
                label={t("sectionsEditor.richTextField.orderedList")}
                onClick={() => editor.chain().focus().toggleOrderedList().run()}
              >
                <span className="text-[11px] font-semibold leading-none">
                  1.
                </span>
              </ToolbarButton>
            </>
          )}

          <div className="mx-0.5 h-4 w-px bg-border" />

          <RichTextLinkControl
            editor={editor}
            active={marks.link}
            open={linkOpen}
            onOpenChange={setLinkOpen}
          />

          {!inline && (
            <>
              <div className="mx-0.5 h-4 w-px bg-border" />

              <ToolbarButton
                active={marks.alignLeft}
                label={t("sectionsEditor.richTextField.alignLeft")}
                onClick={() =>
                  editor.chain().focus().setTextAlign("left").run()
                }
              >
                <AlignLeft size={14} />
              </ToolbarButton>
              <ToolbarButton
                active={marks.alignCenter}
                label={t("sectionsEditor.richTextField.alignCenter")}
                onClick={() =>
                  editor.chain().focus().setTextAlign("center").run()
                }
              >
                <AlignCenter size={14} />
              </ToolbarButton>
              <ToolbarButton
                active={marks.alignRight}
                label={t("sectionsEditor.richTextField.alignRight")}
                onClick={() =>
                  editor.chain().focus().setTextAlign("right").run()
                }
              >
                <AlignRight size={14} />
              </ToolbarButton>
              <ToolbarButton
                active={marks.alignJustify}
                label={t("sectionsEditor.richTextField.alignJustify")}
                onClick={() =>
                  editor.chain().focus().setTextAlign("justify").run()
                }
              >
                <AlignJustify size={14} />
              </ToolbarButton>
            </>
          )}
        </div>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

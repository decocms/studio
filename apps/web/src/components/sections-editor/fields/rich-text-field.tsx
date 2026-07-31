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
import { FontSize, TextStyle } from "@tiptap/extension-text-style";
import { Label } from "@deco/ui/components/label.tsx";
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
import { RichTextLinkControl, ToolbarButton } from "../rich-text-link-control";

/** Heading levels the editor supports, in dropdown order. */
const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

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
}: FieldProps) {
  const t = useT();
  const strValue = typeof value === "string" ? value : "";

  const onChangeRef = useRef(onChange);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read only inside the onUpdate callback, never during render
  onChangeRef.current = onChange;

  const [linkOpen, setLinkOpen] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [...HEADING_LEVELS] },
        // Clear the extension's default target/rel so each link's own
        // `target` attribute controls same-tab vs new-tab (see link control).
        link: { HTMLAttributes: {} },
      }),
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
      // FontSize stores its px value on the textStyle mark, so both are needed.
      TextStyle,
      FontSize,
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
      // 0 = paragraph (no heading active), otherwise the active heading level.
      headingLevel:
        HEADING_LEVELS.find(
          (level) => editor?.isActive("heading", { level }) ?? false,
        ) ?? 0,
      // px string (e.g. "18px") when a size is set on the selection, else null.
      fontSize: (editor?.getAttributes("textStyle").fontSize as string) ?? null,
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
                  {t("sectionsEditor.richTextField.styleHeading", { level })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

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

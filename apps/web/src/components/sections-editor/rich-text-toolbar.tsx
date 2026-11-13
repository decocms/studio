import { type ReactNode, useState } from "react";
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
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { useT } from "@/i18n/use-t.ts";
import { RichTextColorControl } from "./rich-text-color-control";
import {
  type LinkSource,
  RichTextLinkControl,
  ToolbarButton,
} from "./rich-text-link-control";

/** Heading levels the editor supports, in dropdown order. */
const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

/**
 * The font-size stepper's unit and bounds. The unit is part of the stored
 * HTML (`font-size: 12pt`), so an editor steps in the unit its content was
 * written in: stepping a `12pt` span in px would mix units in one document.
 */
export interface FontSizeScale {
  unit: "px" | "pt";
  /** Shown when the selection has no size of its own. */
  initial: number;
  min: number;
  max: number;
}

/** The blocks form's scale: px, defaulting to the prose base. */
const PX_FONT_SIZE: FontSizeScale = {
  unit: "px",
  initial: 16,
  min: 8,
  max: 128,
};

function Divider() {
  return <div className="mx-0.5 h-4 w-px bg-border" />;
}

/**
 * The formatting bar shared by the blocks form's rich-text field and the blog's
 * HTML post body: text style, font size, marks, color, lists, link and
 * alignment. `extras` renders after the built-in groups, for controls only one
 * surface offers.
 *
 * Mark state is selected with `useEditorState`: TipTap v3 no longer re-renders
 * on transactions, so state read during render would go stale.
 */
export function RichTextToolbar({
  editor,
  inline = false,
  fontSize = PX_FONT_SIZE,
  linkSources,
  extras,
}: {
  editor: Editor;
  /**
   * Hide the block-structure controls (heading/list/align): an inline value
   * is serialized without a block wrapper, so they would not survive.
   */
  inline?: boolean;
  fontSize?: FontSizeScale;
  /** Extra pick-a-target tabs in the link control (post/product links). */
  linkSources?: LinkSource[];
  extras?: ReactNode;
}) {
  const t = useT();
  const [linkOpen, setLinkOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);

  const marks = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      underline: editor.isActive("underline"),
      strike: editor.isActive("strike"),
      // 0 = paragraph (no heading active), otherwise the active heading level.
      headingLevel:
        HEADING_LEVELS.find((level) => editor.isActive("heading", { level })) ??
        0,
      // e.g. "18px" when a size is set on the selection, else null.
      fontSize: (editor.getAttributes("textStyle").fontSize as string) ?? null,
      // hex string (e.g. "#e11d48") when a color is set, else null.
      color: (editor.getAttributes("textStyle").color as string) ?? null,
      bulletList: editor.isActive("bulletList"),
      orderedList: editor.isActive("orderedList"),
      link: editor.isActive("link"),
      alignLeft: editor.isActive({ textAlign: "left" }),
      alignCenter: editor.isActive({ textAlign: "center" }),
      alignRight: editor.isActive({ textAlign: "right" }),
      alignJustify: editor.isActive({ textAlign: "justify" }),
    }),
  });

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

  // A size in another unit is not a step on this scale, so it shows the default.
  const parsedFontSize = marks.fontSize?.endsWith(fontSize.unit)
    ? parseFloat(marks.fontSize)
    : NaN;
  const currentFontSize = Number.isFinite(parsedFontSize)
    ? parsedFontSize
    : fontSize.initial;
  const applyFontSize = (size: number) => {
    const clamped = Math.min(fontSize.max, Math.max(fontSize.min, size));
    editor.chain().focus().setFontSize(`${clamped}${fontSize.unit}`).run();
  };

  return (
    <div className="relative flex flex-wrap items-center gap-0.5 rounded-t-[inherit] border-b border-border/60 bg-muted/30 px-1.5 py-1">
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
          <Divider />

          <Select value={styleValue} onValueChange={applyStyle}>
            <SelectTrigger
              size="sm"
              aria-label={t("sectionsEditor.richTextField.styleLabel")}
              // Keep the editor selection while opening the dropdown.
              onMouseDown={(e) => e.preventDefault()}
              // Flat, so it blends with the ghost-style toolbar.
              className="w-[116px] gap-1 bg-transparent px-2 text-muted-foreground shadow-none! hover:bg-accent hover:text-foreground"
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

      <Divider />

      <div className="flex items-center gap-0.5">
        <ToolbarButton
          active={false}
          label={t("sectionsEditor.richTextField.fontSizeDecrease")}
          onClick={() => applyFontSize(currentFontSize - 1)}
        >
          <Minus size={14} />
        </ToolbarButton>
        <span className="min-w-[2ch] text-center text-xs tabular-nums text-muted-foreground">
          {currentFontSize}
        </span>
        <ToolbarButton
          active={false}
          label={t("sectionsEditor.richTextField.fontSizeIncrease")}
          onClick={() => applyFontSize(currentFontSize + 1)}
        >
          <Plus size={14} />
        </ToolbarButton>
      </div>

      <Divider />

      <RichTextColorControl
        editor={editor}
        currentColor={marks.color}
        open={colorOpen}
        onOpenChange={setColorOpen}
      />

      {!inline && (
        <>
          <Divider />

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
            <span className="text-2xs font-semibold leading-none">1.</span>
          </ToolbarButton>
        </>
      )}

      <Divider />

      <RichTextLinkControl
        editor={editor}
        active={marks.link}
        open={linkOpen}
        onOpenChange={setLinkOpen}
        sources={linkSources}
      />

      {!inline && (
        <>
          <Divider />

          <ToolbarButton
            active={marks.alignLeft}
            label={t("sectionsEditor.richTextField.alignLeft")}
            onClick={() => editor.chain().focus().setTextAlign("left").run()}
          >
            <AlignLeft size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={marks.alignCenter}
            label={t("sectionsEditor.richTextField.alignCenter")}
            onClick={() => editor.chain().focus().setTextAlign("center").run()}
          >
            <AlignCenter size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={marks.alignRight}
            label={t("sectionsEditor.richTextField.alignRight")}
            onClick={() => editor.chain().focus().setTextAlign("right").run()}
          >
            <AlignRight size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={marks.alignJustify}
            label={t("sectionsEditor.richTextField.alignJustify")}
            onClick={() => editor.chain().focus().setTextAlign("justify").run()}
          >
            <AlignJustify size={14} />
          </ToolbarButton>
        </>
      )}

      {extras && (
        <>
          <Divider />
          {extras}
        </>
      )}
    </div>
  );
}

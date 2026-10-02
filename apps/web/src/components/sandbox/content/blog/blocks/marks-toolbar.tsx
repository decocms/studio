import { useState } from "react";
import {
  Bold01,
  Italic01,
  Strikethrough01,
  Underline01,
} from "@untitledui/icons";
import type { Editor } from "@tiptap/core";
import type { BubbleMenuPluginProps } from "@tiptap/extension-bubble-menu";
import { BubbleMenu } from "@tiptap/react/menus";
import { useEditorState } from "@tiptap/react";
import {
  type LinkSource,
  RichTextLinkControl,
} from "@/components/sections-editor/rich-text-link-control";
import { useT } from "@/i18n/use-t.ts";
import { ToolbarButton } from "./primitives";

/** Follows the caret, not just a selection — marks apply to what's typed next. */
const shouldShowMarks: NonNullable<BubbleMenuPluginProps["shouldShow"]> = ({
  editor,
  state,
}) => editor.isEditable && (editor.isFocused || !state.selection.empty);

/** Below the caret — above is where the block's format toolbar already sits. */
const MARKS_MENU_OPTIONS = { placement: "bottom-start", offset: 8 } as const;

/**
 * Toolbar for the marks that apply to the text at the caret (or under the
 * selection) inside an inline editor: list items, table cells. Separate from
 * any block toolbar, which owns the block's own format.
 */
export function InlineMarksToolbar({
  editor,
  appendTo,
  sources,
}: {
  editor: Editor;
  /** Extra link targets (a post, a product) — see {@link RichTextLinkControl}. */
  sources?: LinkSource[];
  /**
   * Mount point, for escaping a scroll container that would clip the menu. Must
   * be stable, and must not contain the editors themselves: TipTap keeps the
   * menu open when focus moves inside the mount point's parent.
   */
  appendTo?: HTMLElement;
}) {
  const t = useT();
  const [linkOpen, setLinkOpen] = useState(false);
  // State, not a ref: `appendTo` re-registers the plugin if it isn't stable.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const target = appendTo ?? host;

  const marks = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      underline: editor.isActive("underline"),
      strike: editor.isActive("strike"),
      link: editor.isActive("link"),
    }),
  });

  return (
    <div ref={setHost} className="relative z-20">
      {target && (
        <BubbleMenu
          editor={editor}
          appendTo={target}
          shouldShow={shouldShowMarks}
          options={MARKS_MENU_OPTIONS}
          className="z-50 flex items-center gap-0.5 rounded-md border bg-popover p-0.5 shadow-md"
        >
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
          <RichTextLinkControl
            editor={editor}
            active={marks.link}
            open={linkOpen}
            onOpenChange={setLinkOpen}
            sources={sources}
          />
        </BubbleMenu>
      )}
    </div>
  );
}

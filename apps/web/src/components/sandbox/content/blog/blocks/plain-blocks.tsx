import { useRef, useState } from "react";
import {
  Bold01,
  Italic01,
  Strikethrough01,
  Underline01,
} from "@untitledui/icons";
import type { Editor } from "@tiptap/core";
import type { BubbleMenuPluginProps } from "@tiptap/extension-bubble-menu";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { RichTextLinkControl } from "@/components/sections-editor/rich-text-link-control";
import { listHtmlToRows, rowsToListHtml } from "./list-html";
import { FloatingToolbar, InlineText, ToolbarButton } from "./primitives";

const HEADING_LEVELS = ["1", "2", "3"] as const;

const HEADING_LABEL_KEY = {
  "1": "sandbox.plainBlocks.headingLevel1",
  "2": "sandbox.plainBlocks.headingLevel2",
  "3": "sandbox.plainBlocks.headingLevel3",
} as const;

const HEADING_CLASS: Record<string, string> = {
  "1": "text-3xl font-bold",
  "2": "text-2xl font-bold",
  "3": "text-xl font-semibold",
  "4": "text-lg font-semibold",
  "5": "text-base font-semibold",
  "6": "text-sm font-semibold",
};

export function HeadingBlock({
  text,
  level,
  onChange,
}: {
  text: string;
  level: string;
  onChange: (next: { text: string; level: string }) => void;
}) {
  const [focused, setFocused] = useState(false);
  const t = useT();
  const lvl = level || "2";

  return (
    <div className="relative">
      {focused && (
        <FloatingToolbar>
          {HEADING_LEVELS.map((l) => (
            <ToolbarButton
              key={l}
              active={lvl === l}
              label={t(HEADING_LABEL_KEY[l])}
              onClick={() => onChange({ text, level: l })}
            >
              H{l}
            </ToolbarButton>
          ))}
        </FloatingToolbar>
      )}
      <InlineText
        value={text}
        onChange={(v) => onChange({ text: v, level: lvl })}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={t("sandbox.plainBlocks.headingPlaceholder")}
        className={cn(
          "text-foreground",
          HEADING_CLASS[lvl] ?? HEADING_CLASS["2"],
        )}
      />
    </div>
  );
}

export function QuoteBlock({
  quote,
  onChange,
}: {
  quote: string;
  onChange: (quote: string) => void;
}) {
  const t = useT();
  return (
    <div className="border-l-2 border-foreground/30 pl-4">
      <InlineText
        value={quote}
        onChange={onChange}
        placeholder={t("sandbox.plainBlocks.quotePlaceholder")}
        className="text-lg italic text-foreground/90"
      />
    </div>
  );
}

export function CodeBlock({
  code,
  language,
  onChange,
}: {
  code: string;
  language: string;
  onChange: (next: { code: string; language: string }) => void;
}) {
  const t = useT();
  return (
    <div className="overflow-hidden rounded-md border bg-muted/50">
      <input
        value={language}
        onChange={(e) => onChange({ code, language: e.target.value })}
        placeholder={t("sandbox.plainBlocks.languagePlaceholder")}
        className="w-full border-b bg-transparent px-3 py-1.5 font-mono text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/50"
      />
      <InlineText
        value={code}
        onChange={(v) => onChange({ code: v, language })}
        placeholder={t("sandbox.plainBlocks.codePlaceholder")}
        spellCheck={false}
        className="px-3 py-2.5 font-mono text-sm text-foreground"
      />
    </div>
  );
}

/** Follows the caret, not just a selection — marks apply to what's typed next. */
const shouldShowMarks: NonNullable<BubbleMenuPluginProps["shouldShow"]> = ({
  editor,
  state,
}) => editor.isEditable && (editor.isFocused || !state.selection.empty);

/** Below the caret — above is where the block's format toolbar already sits. */
const MARKS_MENU_OPTIONS = { placement: "bottom-start", offset: 8 } as const;

/**
 * Toolbar for a List block's *content*: the marks that apply to the text at
 * the caret (or under the selection). Separate from the block toolbar, which
 * owns the list format — bulleted vs numbered.
 */
function ListMarksToolbar({ editor }: { editor: Editor }) {
  const t = useT();
  const [linkOpen, setLinkOpen] = useState(false);
  // State, not a ref: `appendTo` re-registers the plugin if it isn't stable.
  const [host, setHost] = useState<HTMLDivElement | null>(null);

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
      {host && (
        <BubbleMenu
          editor={editor}
          appendTo={host}
          shouldShow={shouldShowMarks}
          options={MARKS_MENU_OPTIONS}
          className="flex items-center gap-0.5 rounded-md border bg-popover p-0.5 shadow-md"
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
          />
        </BubbleMenu>
      )}
    </div>
  );
}

/**
 * Editor surface for a List block. Two toolbars, because they answer two
 * different questions: the block toolbar above picks the list *format*
 * (bulleted / numbered), and the bubble toolbar over a selection formats the
 * item's *content*. Backed by a TipTap list over deco's `items` + `style`
 * shape — see `list-html.ts`.
 */
export function ListBlock({
  items,
  style,
  onChange,
}: {
  items: string;
  style: string;
  onChange: (next: { items: string; style: string }) => void;
}) {
  const t = useT();

  // Read from onUpdate only — recreating the editor would reset selection/undo.
  const onChangeRef = useRef(onChange);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read only inside the onUpdate callback, never during render
  onChangeRef.current = onChange;
  const styleRef = useRef(style);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read only inside the onUpdate callback, never during render
  styleRef.current = style;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Cleared so each link's own `target` decides same-tab vs new-tab.
        link: { HTMLAttributes: {} },
        // The block IS a list; every other structure is its own deco block.
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        dropcursor: false,
        gapcursor: false,
      }),
      Placeholder.configure({
        placeholder: t("sandbox.plainBlocks.listItemPlaceholder"),
      }),
    ],
    content: rowsToListHtml(items, style === "ordered"),
    editorProps: {
      attributes: {
        // Markers styled by hand: `prose` is a no-op here (no typography plugin).
        class: cn(
          "focus:outline-none text-[15px] leading-relaxed",
          "[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-7 [&_ol]:pl-7",
          "[&_ul]:my-0 [&_ol]:my-0 [&_li]:pl-1.5 [&_li]:my-1 [&_p]:my-0",
          "marker:text-muted-foreground marker:tabular-nums",
        ),
      },
      // Swallow Tab: a flat `items` string has nowhere to put nesting.
      handleKeyDown: (_view, event) => event.key === "Tab",
    },
    onUpdate: ({ editor }) => {
      onChangeRef.current({
        items: listHtmlToRows(editor.getHTML()).join("\n"),
        style: editor.isActive("orderedList")
          ? "ordered"
          : editor.isActive("bulletList")
            ? "unordered"
            : styleRef.current,
      });
    },
  });

  // TipTap v3 doesn't re-render on transactions; select focus/format reactively.
  const format = useEditorState({
    editor,
    selector: ({ editor }) => ({
      isFocused: editor?.isFocused ?? false,
      bullet: editor?.isActive("bulletList") ?? false,
      ordered: editor?.isActive("orderedList") ?? false,
    }),
  });

  if (!editor) return null;

  return (
    <div className="relative">
      {format.isFocused && (
        <FloatingToolbar>
          <ToolbarButton
            active={format.bullet}
            label={t("sandbox.plainBlocks.bulletedLabel")}
            // Toggling the active type would lift the items out of the list.
            onClick={() =>
              !format.bullet && editor.chain().focus().toggleBulletList().run()
            }
          >
            •
          </ToolbarButton>
          <ToolbarButton
            active={format.ordered}
            label={t("sandbox.plainBlocks.numberedLabel")}
            onClick={() =>
              !format.ordered &&
              editor.chain().focus().toggleOrderedList().run()
            }
          >
            1.
          </ToolbarButton>
        </FloatingToolbar>
      )}
      <ListMarksToolbar editor={editor} />
      <EditorContent editor={editor} className="text-foreground" />
    </div>
  );
}

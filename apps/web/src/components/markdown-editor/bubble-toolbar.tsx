import { useState } from "react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
// `@tiptap/react/menus` imports this package at runtime without declaring it as
// a peer, so apps/web has to depend on it directly.
import type { BubbleMenuPluginProps } from "@tiptap/extension-bubble-menu";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  Bold01,
  Code01,
  Italic01,
  LeftIndent01,
  List,
  Strikethrough01,
} from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import { ToolbarButton } from "../sections-editor/rich-text-link-control";
import { LinkPopover } from "./link-popover";

const Divider = () => <div className="mx-0.5 h-4 w-px bg-border" />;

/** Text glyph for controls with no icon in the set (headings, ordered list). */
const Glyph = ({ children }: { children: string }) => (
  <span className="text-[11px] font-semibold leading-none">{children}</span>
);

const HEADING_LEVELS = [1, 2, 3] as const;

/**
 * The default fires for any non-empty selection, including a selected image or
 * attachment node, or a code block — where none of these controls apply.
 */
const shouldShow: NonNullable<BubbleMenuPluginProps["shouldShow"]> = ({
  editor,
  state,
}) =>
  editor.isEditable &&
  !state.selection.empty &&
  !editor.isActive("image") &&
  !editor.isActive("attachment") &&
  !editor.isActive("codeBlock");

/**
 * Formatting toolbar that appears over a text selection. The canvas stays a
 * blank page while writing — markdown shortcuts cover the fast path, and this
 * covers discovery for anyone who doesn't know them.
 */
export function BubbleToolbar({ editor }: { editor: Editor }) {
  const t = useT();
  // The plugin wraps the menu in a positioned element of its own, so a z-index
  // on the menu itself never applies — it has to sit on an ancestor, which
  // means handing the plugin a host to mount into. State, not a ref: `appendTo`
  // has to be a stable value, or the menu re-registers on every render.
  //
  // Staying inside the editor's DOM also matters: appended to the body, a click
  // on a control would be an outside interaction that closes the host dialog.
  const [host, setHost] = useState<HTMLDivElement | null>(null);

  // TipTap v3 doesn't re-render on transactions, so active state has to be
  // selected reactively or the highlights go stale.
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      strike: editor.isActive("strike"),
      code: editor.isActive("code"),
      headings: HEADING_LEVELS.map((level) =>
        editor.isActive("heading", { level }),
      ),
      bulletList: editor.isActive("bulletList"),
      orderedList: editor.isActive("orderedList"),
      blockquote: editor.isActive("blockquote"),
    }),
  });

  const headingLabels = {
    1: t("markdownEditor.heading1"),
    2: t("markdownEditor.heading2"),
    3: t("markdownEditor.heading3"),
  } as const;

  return (
    // z-20: the menu floats above the selection, so over the first line it
    // lands on the host's sticky header (z-10 in the task dialog) — under that
    // opaque header, half the controls are invisible.
    <div ref={setHost} className="relative z-20">
      {host && (
        <BubbleMenu
          editor={editor}
          shouldShow={shouldShow}
          appendTo={host}
          className="flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md"
          aria-label={t("markdownEditor.toolbarAriaLabel")}
        >
          <ToolbarButton
            active={state.bold}
            label={t("markdownEditor.bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold01 size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={state.italic}
            label={t("markdownEditor.italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic01 size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={state.strike}
            label={t("markdownEditor.strikethrough")}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <Strikethrough01 size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={state.code}
            label={t("markdownEditor.code")}
            onClick={() => editor.chain().focus().toggleCode().run()}
          >
            <Code01 size={14} />
          </ToolbarButton>

          <Divider />

          {HEADING_LEVELS.map((level, i) => (
            <ToolbarButton
              key={level}
              active={state.headings[i] ?? false}
              label={headingLabels[level]}
              onClick={() =>
                editor.chain().focus().toggleHeading({ level }).run()
              }
            >
              <Glyph>{`H${level}`}</Glyph>
            </ToolbarButton>
          ))}

          <Divider />

          <ToolbarButton
            active={state.bulletList}
            label={t("markdownEditor.bulletList")}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List size={14} />
          </ToolbarButton>
          <ToolbarButton
            active={state.orderedList}
            label={t("markdownEditor.orderedList")}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <Glyph>1.</Glyph>
          </ToolbarButton>
          <ToolbarButton
            active={state.blockquote}
            label={t("markdownEditor.quote")}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            <LeftIndent01 size={14} />
          </ToolbarButton>

          <Divider />

          <LinkPopover editor={editor} />
        </BubbleMenu>
      )}
    </div>
  );
}
